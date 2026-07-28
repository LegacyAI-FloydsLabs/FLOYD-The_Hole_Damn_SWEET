import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  FLOYD_KEYCHAIN_SERVICE,
  MacOSKeychainVault,
} from "../server/keychain-vault.mjs";

function fakeKeychain() {
  const values = new Map();
  const calls = [];
  // Emulates the observed behavior of /usr/bin/security on macOS:
  // -i consumes a quoted command line from stdin (truncating around 4KB),
  // and direct argv mode receives the secret as the -w value.
  const exec = (command, args, options = {}) => {
    calls.push([command, ...args]);
    assert.equal(command, "/usr/bin/security");
    if (args[0] === "-i") {
      const line = String(options.input || "").split("\n")[0].slice(0, 4096);
      const parts = line.match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
      const tokens = parts.map((part) => (part.startsWith('"')
        ? part.slice(1, -1).replace(/\\(.)/g, "$1")
        : part));
      return runOperation(tokens, options);
    }
    return runOperation(args, options);
  };
  function runOperation(args, options) {
    const operation = args[0];
    const account = args[args.indexOf("-a") + 1];
    const service = args[args.indexOf("-s") + 1];
    if (operation === "add-generic-password") {
      assert.equal(service, FLOYD_KEYCHAIN_SERVICE);
      const flag = args.indexOf("-w");
      assert.notEqual(flag, -1);
      values.set(account, args[flag + 1] ?? "");
      return "";
    }
    if (operation === "find-generic-password") {
      assert.equal(service, FLOYD_KEYCHAIN_SERVICE);
      if (!values.has(account)) throw Object.assign(new Error("not found"), { status: 44 });
      return `${values.get(account)}\n`;
    }
    if (operation === "delete-generic-password") {
      assert.equal(service, FLOYD_KEYCHAIN_SERVICE);
      if (!values.delete(account)) throw Object.assign(new Error("not found"), { status: 44 });
      return "";
    }
    throw new Error(`unexpected security operation ${operation}`);
  }
  return { values, calls, exec };
}

test("provider JSON and management authorization live in Keychain items", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  vault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.providers, { zai: { key: "real-secret" } });
  assert.deepEqual(vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers), { zai: { key: "real-secret" } });
  const first = vault.ensureManagementToken();
  assert.match(first, /^fm_[0-9a-f]{64}$/);
  assert.equal(vault.ensureManagementToken(), first);
  assert.ok(fake.calls.every((call) => call[0] === "/usr/bin/security"));
  // Small secrets travel via -i stdin, so no argv frame contains the value.
  assert.ok(fake.calls.every((call) => !JSON.stringify(call).includes("real-secret")));
});

test("Keychain access fails closed off macOS and rejects unscoped accounts", () => {
  assert.throws(() => new MacOSKeychainVault({ platform: "linux" }), /requires the macOS Keychain/);
  const vault = new MacOSKeychainVault({ exec: fakeKeychain().exec, platform: "darwin" });
  assert.throws(() => vault.get("other-secret"), /unsupported FLOYD Keychain account/);
});

test("malformed Keychain data is rejected instead of silently replaced", () => {
  const fake = fakeKeychain();
  fake.values.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, "not-json");
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  assert.throws(() => vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers), /not valid JSON/);
});

test("writes are verified by read-back so a silent truncation cannot pass", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.management, `fm_${"a".repeat(64)}`);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.management), `fm_${"a".repeat(64)}`);
  // Simulate a stored value diverging from the requested one (the shape of
  // security's silent truncation bugs, which exit 0).
  const truncatingExec = (command, args, options = {}) => {
    if (args[0] === "-i" || args[0] === "add-generic-password") {
      fake.exec(command, args, options);
      const account = FLOYD_KEYCHAIN_ACCOUNTS.management;
      fake.values.set(account, String(fake.values.get(account) || "").slice(0, 8));
      return "";
    }
    return fake.exec(command, args, options);
  };
  const broken = new MacOSKeychainVault({ exec: truncatingExec, platform: "darwin" });
  assert.throws(
    () => broken.set(FLOYD_KEYCHAIN_ACCOUNTS.management, `fm_${"b".repeat(64)}`),
    /write verification failed/,
  );
});

test("large secrets round-trip through the chunked stdin path and quoted values survive -i", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const big = { tokens: { access: "x".repeat(4200) } };
  vault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, big);
  assert.deepEqual(vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription), big);
  // Above the -i limit the primary item holds a manifest, never the value.
  assert.match(
    fake.values.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription),
    /^fvchunks:v1:\d+:[0-9a-f]{64}$/,
  );
  const quoted = { zai: { key: 'sk-cp-abc"def\\ghi' } };
  vault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.providers, quoted);
  assert.deepEqual(vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers), quoted);
  assert.throws(
    () => vault.set(FLOYD_KEYCHAIN_ACCOUNTS.management, "line1\nline2"),
    /single line/,
  );
});

test("a crash between delete and create is recoverable via the staged backup", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, "irreplaceable-provider-keys");
  // Simulate the process dying between delete-generic-password and
  // add-generic-password for the target account: the add call itself throws
  // (the backup account's own add must still succeed, it is the safety net).
  const crashyExec = (command, args, options = {}) => {
    const line = args[0] === "-i" ? String(options.input || "") : args.join(" ");
    if (line.includes("add-generic-password")
      && line.includes(FLOYD_KEYCHAIN_ACCOUNTS.providers)
      && !line.includes(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups)) {
      throw new Error("simulated crash mid-swap");
    }
    return fake.exec(command, args, options);
  };
  const dying = new MacOSKeychainVault({ exec: crashyExec, platform: "darwin" });
  assert.throws(
    () => dying.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, "never-lands"),
    /simulated crash mid-swap/,
  );
  // The target item is gone; only the staged envelope survives.
  assert.equal(fake.values.has(FLOYD_KEYCHAIN_ACCOUNTS.providers), false);
  const envelope = JSON.parse(fake.values.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups));
  assert.equal(envelope.account, FLOYD_KEYCHAIN_ACCOUNTS.providers);
  assert.equal(envelope.value, "irreplaceable-provider-keys");
  assert.ok(envelope.staged_at);
  // A fresh vault (next startup) restores the old value and clears the stage.
  const recovered = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  assert.equal(recovered.get(FLOYD_KEYCHAIN_ACCOUNTS.providers), "irreplaceable-provider-keys");
  assert.equal(recovered.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups), null);
  // Explicit helper call is idempotent once the stage is spent.
  assert.equal(MacOSKeychainVault.recoverStagedWrite(recovered), null);
});

test("successful overwrites stage the old value and then clear the backup", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, "old-value");
  const callsBefore = fake.calls.length;
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, "new-value");
  // The overwrite staged the old value into the backup account mid-flight...
  const flight = fake.calls.slice(callsBefore).map((call) => call.join(" "));
  assert.ok(flight.some((line) => line.includes(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups)));
  // ...and cleared it after the verified write, leaving only the new value.
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.providers), "new-value");
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups), null);
  assert.equal(fake.values.size, 1);
  // Recovery does nothing when the completed write is already in place: a
  // stale envelope must never roll back a newer verified value.
  fake.values.set(
    FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups,
    JSON.stringify({ account: FLOYD_KEYCHAIN_ACCOUNTS.providers, value: "old-value", staged_at: "x" }),
  );
  assert.equal(MacOSKeychainVault.recoverStagedWrite(vault), null);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.providers), "new-value");
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups), null);
});

test("chunked values above 7KB round-trip and never appear in argv", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const secret = `oauth-${"s".repeat(7300)}-end`;
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, secret);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription), secret);
  // Primary item is a manifest; the value lives in derived #n chunk accounts.
  const manifest = fake.values.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription);
  const match = manifest.match(/^fvchunks:v1:(\d+):[0-9a-f]{64}$/);
  assert.ok(match, `manifest marker expected, got: ${manifest.slice(0, 40)}`);
  const count = Number(match[1]);
  assert.ok(count >= 3, `7KB+ should need >= 3 chunks, got ${count}`);
  for (let i = 0; i < count; i += 1) {
    assert.ok(fake.values.has(`${FLOYD_KEYCHAIN_ACCOUNTS.subscription}#${i}`));
  }
  // NO recorded call may carry any slice of the secret in argv: chunks travel
  // exclusively on -i stdin. Check every argv frame against every 100-char
  // window of the secret (covers whole-value AND per-chunk exposure).
  for (const call of fake.calls) {
    for (const arg of call) {
      assert.ok(!secret.includes(arg) || arg.length < 64, `secret material in argv: ${arg.slice(0, 40)}`);
      assert.ok(!String(arg).includes(secret.slice(0, 100)), "secret prefix leaked into argv");
      assert.ok(!String(arg).includes("s".repeat(200)), "chunk body leaked into argv");
    }
  }
});

test("a corrupted or missing chunk fails closed and names the account", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const secret = "c".repeat(8000);
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, secret);
  // Corrupt one chunk in place: the manifest sha256 must catch it.
  fake.values.set(`${FLOYD_KEYCHAIN_ACCOUNTS.subscription}#1`, "tampered");
  assert.throws(
    () => vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription),
    /integrity verification.*chatgpt-subscription/,
  );
  // Remove the chunk entirely: missing chunks must not yield partial data.
  fake.values.delete(`${FLOYD_KEYCHAIN_ACCOUNTS.subscription}#1`);
  assert.throws(
    () => vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription),
    /chunk chatgpt-subscription#1 is missing/,
  );
});

test("delete on a chunked account removes the manifest and every chunk", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, "d".repeat(9500));
  assert.ok(fake.values.size >= 4); // manifest + at least 3 chunks
  assert.equal(vault.delete(FLOYD_KEYCHAIN_ACCOUNTS.subscription), true);
  assert.equal(fake.values.size, 0);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription), null);
  // Shrinking a chunked value also sweeps the now-stale chunk indexes.
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, "e".repeat(9500));
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, "small");
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription), "small");
  assert.equal(fake.values.size, 1);
});

test("staged backup captures the full logical value for chunked accounts", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const oldValue = `precious-${"p".repeat(8100)}`;
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, oldValue);
  // Crash on the target swap: any add to the providers primary or its chunk
  // accounts dies. Envelope writes to migration-backup-keys must survive.
  const crashyExec = (command, args, options = {}) => {
    const line = args[0] === "-i" ? String(options.input || "") : args.join(" ");
    if (line.includes("add-generic-password")
      && new RegExp(`"-a" "${FLOYD_KEYCHAIN_ACCOUNTS.providers}(#\\d+)?"`).test(line)) {
      throw new Error("simulated crash mid-swap");
    }
    return fake.exec(command, args, options);
  };
  const dying = new MacOSKeychainVault({ exec: crashyExec, platform: "darwin" });
  assert.throws(
    () => dying.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, `replacement-${"r".repeat(8200)}`),
    /simulated crash mid-swap/,
  );
  // The envelope holds the FULL previous logical value, not the manifest
  // marker string (the envelope itself is chunked transparently).
  const envelope = JSON.parse(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups));
  assert.equal(envelope.account, FLOYD_KEYCHAIN_ACCOUNTS.providers);
  assert.equal(envelope.value, oldValue);
  assert.ok(!envelope.value.startsWith("fvchunks:"));
  // Startup recovery restores the full chunked value and spends the stage.
  const recovered = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  assert.equal(recovered.get(FLOYD_KEYCHAIN_ACCOUNTS.providers), oldValue);
  assert.equal(recovered.get(FLOYD_KEYCHAIN_ACCOUNTS.migrationBackups), null);
});

test("no recorded security call ever carries a secret in argv", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const secrets = [
    "tiny-secret-value",
    `fm_${"f".repeat(64)}`,
    `giant-${"g".repeat(10000)}`,
    'quoted "secret" with \\backslashes\\ inside-' + "q".repeat(5000),
  ];
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.providers, secrets[0]);
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.management, secrets[1]);
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.subscription, secrets[2]);
  vault.set(FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets, secrets[3]);
  // Exercise the read path too so find/delete calls are also recorded.
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.providers), secrets[0]);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.subscription), secrets[2]);
  assert.equal(vault.get(FLOYD_KEYCHAIN_ACCOUNTS.remoteMcpTargets), secrets[3]);
  vault.delete(FLOYD_KEYCHAIN_ACCOUNTS.subscription);
  // Every argv frame across every recorded call: neither a full secret nor
  // any non-trivial substring of one may appear.
  for (const call of fake.calls) {
    for (const arg of call.map(String)) {
      for (const secret of secrets) {
        assert.ok(!arg.includes(secret), "full secret leaked into argv");
        assert.ok(!secret.includes(arg) || arg.length < 32,
          `secret substring leaked into argv: ${arg.slice(0, 40)}`);
      }
    }
  }
});
