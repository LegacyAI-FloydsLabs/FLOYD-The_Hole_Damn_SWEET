import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultLeakMonitor } from "../server/vault-leak-monitor.mjs";

test("confirmed active-token file leak triggers rotation once and unknown noise does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-leak-monitor-"));
  const original = `fv_proof_${"a".repeat(48)}`;
  const replacement = `fv_proof_${"b".repeat(48)}`;
  let active = [{ app: "proof", token: original }];
  const alerts = [];
  const actions = [];
  writeFileSync(join(root, "application.log"), `unexpected credential: ${original}\n`);
  writeFileSync(join(root, "noise.log"), `fv_unknown_${"c".repeat(48)}\n`);
  const monitor = createVaultLeakMonitor({
    roots: [root],
    getActiveCapabilities: () => active,
    recordAlert: (kind, detail) => alerts.push({ kind, detail }),
    onConfirmedLeak: async (app, detail) => {
      actions.push(["terminate", app, detail.source]);
      actions.push(["replace-profile", app]);
      actions.push(["restart", app]);
      active = [{ app, token: replacement }];
    },
  });

  await monitor.scanOnce();
  await monitor.scanOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "confirmed_proxy_token_leak");
  assert.deepEqual(actions, [
    ["terminate", "proof", "automatic-file-leak-detector"],
    ["replace-profile", "proof"],
    ["restart", "proof"],
  ]);
});

test("token written after start is detected by a subsequent incremental scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-leak-monitor-"));
  const token = `fv_late_${"d".repeat(48)}`;
  const alerts = [];
  const monitor = createVaultLeakMonitor({
    roots: [root],
    getActiveCapabilities: () => [{ app: "late", token }],
    recordAlert: (kind, detail) => alerts.push({ kind, detail }),
    onConfirmedLeak: async () => {},
    sweepIntervalMs: 3_600_000,
  });
  monitor.start();
  await monitor.scanOnce();
  assert.equal(alerts.length, 0, "clean tree must not alert");

  writeFileSync(join(root, "late-leak.log"), `oops: ${token}\n`);
  await monitor.scanOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "confirmed_proxy_token_leak");
  assert.equal(alerts[0].detail.app, "late");
  monitor.close();
});

test("close() disposes watchers and timers so the process can exit cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-leak-monitor-"));
  writeFileSync(join(root, "plain.log"), "nothing sensitive here\n");
  const monitor = createVaultLeakMonitor({
    roots: [root, join(root, "does-not-exist")],
    getActiveCapabilities: () => [{ app: "idle", token: `fv_idle_${"e".repeat(48)}` }],
    onConfirmedLeak: async () => {},
  });
  monitor.start();
  await monitor.scanOnce();
  monitor.close();
  monitor.close(); // idempotent
  // If a watcher or timer survived close(), the node:test runner would hang
  // instead of exiting; reaching this point with a clean exit is the proof.
  assert.ok(true);
});
