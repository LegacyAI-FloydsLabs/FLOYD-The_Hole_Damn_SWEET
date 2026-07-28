import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TokenStore } from "../server/vault-proxy.mjs";

test("compromise report atomically revokes, replaces, alerts, and terminates active transports", () => {
  const terminated = [];
  const store = new TokenStore(mkdtempSync(join(tmpdir(), "vault-token-rotation-")), {
    onRevoke: (tokenIds) => {
      terminated.push(...tokenIds);
      return tokenIds.length * 2;
    },
  });
  const original = store.ensure("proof");
  const originalRecord = store.list().find((entry) => entry.app === "proof" && !entry.revoked);
  const result = store.rotate("proof", { source: "test", reason: "leak detected" });
  assert.notEqual(result.token, original);
  assert.deepEqual(result.revokedTokenIds, [originalRecord.id]);
  assert.deepEqual(terminated, [originalRecord.id]);
  assert.equal(result.terminatedConnections, 2);
  assert.equal(store.verify(original).revoked.id, originalRecord.id);
  assert.equal(store.verify(result.token).token.app, "proof");
  assert.equal(store.alerts().at(-1).kind, "compromise_rotated");
  const records = store.list().filter((entry) => entry.app === "proof");
  assert.equal(records.filter((entry) => !entry.revoked).length, 1);
  assert.equal(records.filter((entry) => entry.revoked).length, 1);
});
