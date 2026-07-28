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

test("large secrets round-trip through the argv path and quoted values survive -i", () => {
  const fake = fakeKeychain();
  const vault = new MacOSKeychainVault({ exec: fake.exec, platform: "darwin" });
  const big = { tokens: { access: "x".repeat(4200) } };
  vault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription, big);
  assert.deepEqual(vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.subscription), big);
  const quoted = { zai: { key: 'sk-cp-abc"def\\ghi' } };
  vault.writeJson(FLOYD_KEYCHAIN_ACCOUNTS.providers, quoted);
  assert.deepEqual(vault.readJson(FLOYD_KEYCHAIN_ACCOUNTS.providers), quoted);
  assert.throws(
    () => vault.set(FLOYD_KEYCHAIN_ACCOUNTS.management, "line1\nline2"),
    /single line/,
  );
});
