import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "Cache", "Code Cache", "GPUCache"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROTATION_RETRY_MS = 60_000;

/**
 * Detects an active fv capability copied into an unmanaged source/log file.
 * Detection is exact, so unknown-token noise cannot force rotation.
 *
 * Scanning strategy: one full scan at start(), then event-driven incremental
 * scans via recursive fs.watch (debounced), plus a long-interval safety-net
 * full sweep in case watch events are dropped. All filesystem I/O is async and
 * a stat cache (path -> mtime/size) lets sweeps skip re-reading unchanged
 * files. The cache is discarded whenever the active token set changes, so a
 * rotation always forces fresh reads.
 *
 * @param {object} options
 * @param {string[]} options.roots Directories to monitor for leaked tokens.
 * @param {() => Array<{app: string, token: string}>} options.getActiveCapabilities
 *   Returns the currently active capabilities to match against file contents.
 * @param {(app: string, detail: object) => Promise<void>|void} options.onConfirmedLeak
 *   Rotation callback invoked once per confirmed app:token leak.
 * @param {(kind: string, detail: object) => void} [options.recordAlert]
 *   Audit hook invoked before every rotation attempt.
 * @param {number} [options.debounceMs] Delay before scanning watched changes.
 * @param {number} [options.sweepIntervalMs] Safety-net full sweep interval.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @returns {{scanOnce: () => Promise<void>, start: () => void, close: () => void}}
 */
export function createVaultLeakMonitor({
  roots,
  getActiveCapabilities,
  onConfirmedLeak,
  recordAlert = () => {},
  debounceMs = 500,
  sweepIntervalMs = 600_000,
  now = () => Date.now(),
}) {
  if (!Array.isArray(roots) || typeof getActiveCapabilities !== "function"
    || typeof onConfirmedLeak !== "function") {
    throw new Error("Vault leak monitor requires roots, capabilities, and a rotation callback");
  }
  const handled = new Set();
  const retryAfter = new Map();
  const pendingRetries = new Map();
  const pendingPaths = new Map();
  const watchers = new Set();
  let statCache = new Map();
  let cachedSignature = null;
  let debounceTimer = null;
  let sweepTimer = null;
  let scanning = null;
  let started = false;
  let closed = false;
  let lock = Promise.resolve();

  function runLocked(task) {
    const run = lock.then(task);
    lock = run.catch(() => {});
    return run;
  }

  async function scanFile(path, metadata, capabilities, useCache, cache, findings) {
    const cached = useCache ? statCache.get(path) : undefined;
    if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
      cache.set(path, cached);
      return;
    }
    let content;
    try { content = await readFile(path); } catch { return; }
    cache.set(path, { mtimeMs: metadata.mtimeMs, size: metadata.size });
    for (const capability of capabilities) {
      if (typeof capability?.token === "string" && capability.token
        && content.includes(Buffer.from(capability.token))) {
        findings.push({ app: capability.app, token: capability.token, path });
      }
    }
  }

  async function scanPath(path, capabilities, useCache, cache, findings) {
    let metadata;
    try { metadata = await lstat(path); } catch { return; }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(path.split("/").at(-1))) return;
      let children;
      try { children = await readdir(path); } catch { return; }
      for (const child of children) {
        await scanPath(join(path, child), capabilities, useCache, cache, findings);
      }
      return;
    }
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return;
    await scanFile(path, metadata, capabilities, useCache, cache, findings);
  }

  async function processFindings(findings, capabilities) {
    const activeTokens = new Set(capabilities
      .map((capability) => capability?.token)
      .filter((token) => typeof token === "string" && token));
    const byIdentity = new Map();
    for (const finding of findings) {
      const identity = `${finding.app}:${finding.token}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, finding);
    }
    for (const [identity, finding] of pendingRetries) {
      if (handled.has(identity) || !activeTokens.has(finding.token)) {
        pendingRetries.delete(identity);
      } else if (!byIdentity.has(identity)) {
        byIdentity.set(identity, finding);
      }
    }
    for (const [identity, finding] of byIdentity) {
      if (handled.has(identity) || now() < (retryAfter.get(identity) || 0)) continue;
      const alertId = createHash("sha256")
        .update(`${finding.app}\0${finding.path}\0${finding.token}`)
        .digest("hex")
        .slice(0, 16);
      recordAlert("confirmed_proxy_token_leak", {
        app: finding.app,
        source: "automatic-file-leak-detector",
        alertId,
      });
      try {
        await onConfirmedLeak(finding.app, {
          source: "automatic-file-leak-detector",
          reason: "active proxy credential found outside managed Vault configuration",
          alertId,
        });
        handled.add(identity);
        pendingRetries.delete(identity);
      } catch {
        retryAfter.set(identity, now() + ROTATION_RETRY_MS);
        pendingRetries.set(identity, finding);
      }
    }
  }

  async function scanOnce() {
    if (scanning) return scanning;
    scanning = runLocked(async () => {
      const capabilities = getActiveCapabilities();
      const signature = capabilitySignature(capabilities);
      const useCache = signature === cachedSignature;
      cachedSignature = signature;
      const nextCache = new Map();
      const findings = [];
      for (const root of roots) {
        await scanPath(root, capabilities, useCache, nextCache, findings);
      }
      statCache = nextCache;
      await processFindings(findings, capabilities);
    }).finally(() => { scanning = null; });
    return scanning;
  }

  async function scanChangedPaths(entries) {
    await runLocked(async () => {
      if (closed) return;
      const capabilities = getActiveCapabilities();
      const findings = [];
      for (const { path, relative } of entries) {
        if (hasExcludedSegment(relative)) continue;
        statCache.delete(path); // Force a re-read even on same-millisecond edits.
        await scanPath(path, capabilities, true, statCache, findings);
      }
      await processFindings(findings, capabilities);
    });
  }

  function queueChangedPath(root, filename) {
    if (closed) return;
    const relative = typeof filename === "string" ? filename : "";
    pendingPaths.set(relative ? join(root, relative) : root, relative);
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const entries = [...pendingPaths].map(([path, relative]) => ({ path, relative }));
      pendingPaths.clear();
      void scanChangedPaths(entries);
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function watchRoot(root) {
    let watcher;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        queueChangedPath(root, filename);
      });
    } catch {
      return; // Missing root; the safety-net sweep still covers it if created.
    }
    watcher.on("error", () => {
      watchers.delete(watcher);
      try { watcher.close(); } catch { /* already dead */ }
    });
    watcher.unref?.();
    watchers.add(watcher);
  }

  return {
    scanOnce,
    start() {
      if (started || closed) return;
      started = true;
      for (const root of roots) watchRoot(root);
      sweepTimer = setInterval(() => { void scanOnce(); }, sweepIntervalMs);
      sweepTimer.unref?.();
      void scanOnce();
    },
    close() {
      closed = true;
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already dead */ }
      }
      watchers.clear();
      pendingPaths.clear();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
  };
}

function capabilitySignature(capabilities) {
  return capabilities
    .map((capability) => capability?.token)
    .filter((token) => typeof token === "string" && token)
    .sort()
    .join("\0");
}

function hasExcludedSegment(relativePath) {
  return relativePath.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}
