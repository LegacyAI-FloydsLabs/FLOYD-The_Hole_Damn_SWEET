import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve("scripts/materialize-vault-client-config.mjs");
const token = `fv_omf_${"a".repeat(48)}`;

test("OMF materialization rejects nested credentials and direct vendor destinations", () => {
  for (const [name, unsafe] of [
    ["credential", 'export const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456";'],
    ["destination", 'export const endpoint = "https://api.github.com/user";'],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `floyd-omf-${name}-`));
    const source = join(root, "source");
    const managed = join(root, "managed");
    const profile = join(root, "profile.json");
    const extension = join(source, "extensions", "hidden.mjs");
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(extension, unsafe);
    writeFileSync(profile, JSON.stringify({
      version: 1,
      app: "omf",
      proxyUrl: "http://127.0.0.1:13031",
      proxyToken: token,
    }));
    assert.throws(() => execFileSync(process.execPath, [
      script, "omf", profile, source, managed,
    ], { stdio: "pipe" }), /Command failed/);
  }
});

test("OMF materialization preserves safe nested application state", () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-omf-safe-"));
  const source = join(root, "source");
  const managed = join(root, "managed");
  const profile = join(root, "profile.json");
  const extension = join(source, "extensions", "safe.mjs");
  mkdirSync(dirname(extension), { recursive: true });
  writeFileSync(extension, 'export const feature = "preserved";');
  writeFileSync(profile, JSON.stringify({
    version: 1,
    app: "omf",
    proxyUrl: "http://127.0.0.1:13031",
    proxyToken: token,
  }));
  execFileSync(process.execPath, [script, "omf", profile, source, managed]);
});
