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
  const exec = (command, args, options = {}) => {
    calls.push([command, ...args]);
    const operation = args[0];
    const account = args[args.indexOf("-a") + 1];
    const service = args[args.indexOf("-s") + 1];
    assert.equal(command, "/usr/bin/security");
    assert.equal(service, FLOYD_KEYCHAIN_SERVICE);
    if (operation === "find-generic-password") {
      if (!values.has(account)) throw Object.assign(new Error("not found"), { status: 44 });
      return `${values.get(account)}\n`;
    }
    if (operation === "add-generic-password") {
      assert.equal(args.at(-1), "-w");
      assert.ok(!args.includes(String(options.input || "").trim()), "secret appeared in child argv");
      values.set(account, String(options.input || "").replace(/\r?\n$/, ""));
      return "";
    }
    if (operation === "delete-generic-password") {
      if (!values.delete(account)) throw Object.assign(new Error("not found"), { status: 44 });
      return "";
    }
    throw new Error(`unexpected security operation ${operation}`);
  };
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
  assert.ok(fake.calls.every((call) => !JSON.stringify(call).includes("real-secret")));
  const writes = fake.calls.filter((call) => call[1] === "add-generic-password");
  assert.ok(writes.every((call) => call[call.indexOf("-T") + 1] === ""));
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
