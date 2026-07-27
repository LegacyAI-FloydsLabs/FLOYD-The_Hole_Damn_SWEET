// self-update.mjs — FLOYD Desktop Suite update client.
//
// The release pipeline publishes dist/manifest.json + the pkg to
// https://www.floydslabs.com/floyd/. This module:
//   1. reads the installed version (workstation/VERSION, written by the
//      installer build; absent in dev checkouts -> updates disabled),
//   2. fetches the manifest and compares versions,
//   3. downloads the pkg to the runtime root and verifies its sha256
//      before anything may open it (fail closed: bad hash = file deleted).
//
// Installation itself goes through macOS Installer.app (`open <pkg>`): a
// user-approved install, no privileged helper, no silent root execution.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MANIFEST_URL = "https://www.floydslabs.com/floyd/manifest.json";

/** Numeric-aware dotted-version compare: 0.1.2 < 0.1.10 < 0.2.0. */
export function versionGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Installed version, or null in a dev checkout (updates disabled). */
export function installedVersion(repoRoot) {
  try { return readFileSync(join(repoRoot, "VERSION"), "utf8").trim() || null; } catch { return null; }
}

export function createUpdater({ repoRoot, runtimeRoot, manifestUrl = DEFAULT_MANIFEST_URL, fetchImpl = fetch }) {
  const state = {
    current: installedVersion(repoRoot),
    checkedAt: null,
    available: null,      // manifest entry when an update exists
    downloaded: null,     // verified pkg path
    error: null,
  };

  async function check() {
    state.checkedAt = new Date().toISOString();
    state.error = null;
    if (!state.current) { state.error = "dev checkout (no VERSION file); updates disabled"; return state; }
    try {
      const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const m = await res.json();
      if (!m?.version || !m?.pkg_url || !/^[0-9a-f]{64}$/.test(m?.sha256 ?? "")) {
        throw new Error("manifest missing version/pkg_url/sha256");
      }
      state.available = versionGt(m.version, state.current) ? m : null;
    } catch (err) {
      state.error = String(err?.message ?? err);
    }
    return state;
  }

  /** Download the announced pkg and verify sha256. Fail closed. */
  async function download() {
    const entry = state.available;
    if (!entry) throw new Error("no update available (run check first)");
    const dest = join(runtimeRoot, `FLOYD-${entry.version}.pkg`);
    const res = await fetchImpl(entry.pkg_url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`pkg HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest !== entry.sha256) {
      try { unlinkSync(dest); } catch {}
      throw new Error(`sha256 mismatch: manifest ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`);
    }
    writeFileSync(dest, buf);
    state.downloaded = dest;
    return dest;
  }

  return { state, check, download };
}
