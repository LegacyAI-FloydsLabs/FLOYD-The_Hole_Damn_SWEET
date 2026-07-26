import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, openSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeSdkRuntime } from "@floyd/opencode-runtime";
import { PATHS, ENGINE_PORT, LOOPBACK, readUpstreamLock, RUNTIME_ROOT } from "./config.ts";
import { newestMessage, isTerminalAssistant, containsAssistantTurn } from "./engine-logic.ts";

/**
 * Managed loopback OpenCode child.
 * - binary by ABSOLUTE PATH only (PATH `opencode` was a SuperFloyd symlink until 2026-07-11;
 *   even fixed, PATH resolution stays banned here)
 * - sha256 verified against upstream.lock before every spawn; fail closed
 * - fully isolated XDG + config under FLOYD_RUNTIME/engines/opencode
 * - GLM key fetched in-process from `omp auth-broker token zai`; never written to disk
 * - --pure until the Floyd plugin is audited/tested
 */

export class OpenCodeEngine {
  child: ChildProcess | null = null;
  readonly baseUrl = `http://${LOOPBACK}:${ENGINE_PORT}`;
  private readonly runtime = new OpenCodeSdkRuntime({ baseUrl: this.baseUrl });

  verifyBinary(): { path: string; version: string; sha256: string } {
    const lock = readUpstreamLock().opencode;
    const actual = createHash("sha256").update(readFileSync(lock.binary_path)).digest("hex");
    if (actual !== lock.sha256) {
      throw new Error(
        `upstream.lock hash mismatch for ${lock.binary_path}: expected ${lock.sha256}, got ${actual} — refusing to spawn`,
      );
    }
    return { path: lock.binary_path, version: lock.version, sha256: actual };
  }

  /**
   * Credential sourcing for the GLM Coding Plan.
   * The omp auth-broker was removed as a source on 2026-07-12 (Douglas: the
   * openmythos build must not be involved). Investigation record in ADR-001:
   * `omp auth-broker token <provider>` ignores the provider arg and prints the
   * broker's own bearer; its HTTP surface is an openmythos model gateway, not
   * a key vault — wiring it would put openmythos-build code in the model path.
   * Current source: the validated key from the user's opencode config.
   * Every candidate is validated against the coding endpoint; fail closed if none pass.
   */
  async fetchGlmKey(): Promise<{ key: string; source: string }> {
    const candidates: Array<{ key: string; source: string }> = [];
    try {
      const cfg = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".config/opencode/opencode.json"), "utf8")) as {
        provider?: { "zai-coding-plan"?: { options?: { apiKey?: string } } };
      };
      const cfgKey = cfg.provider?.["zai-coding-plan"]?.options?.apiKey;
      if (cfgKey && cfgKey.length >= 10 && !cfgKey.startsWith("{")) {
        candidates.push({ key: cfgKey, source: "user-opencode-config:zai-coding-plan" });
      }
    } catch { /* no config fallback available */ }
    for (const c of candidates) {
      try {
        const r = await fetch("https://api.z.ai/api/coding/paas/v4/models", {
          headers: { authorization: `Bearer ${c.key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) return c;
      } catch { /* try next */ }
    }
    throw new Error(
      `no GLM Coding Plan credential validated (tried: ${candidates.map((c) => c.source).join(", ") || "none"}) — fail closed, no fallback route`,
    );
  }

  async start(): Promise<{ pid: number; version: string; credential_source: string }> {
    const bin = this.verifyBinary();
    const { key, source: credentialSource } = await this.fetchGlmKey();
    const home = PATHS.engineHome;
    mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
    // single credential source (env); remove any auth file left by earlier experiments
    rmSync(join(home, "data", "opencode", "auth.json"), { force: true });
    const logFd = openSync(PATHS.engineLog, "a");
    const env: Record<string, string> = {
      HOME: process.env.HOME ?? "",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", // deliberately minimal; no homebrew shims
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config-home"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_CONFIG: PATHS.engineConfig,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      FLOYD_GLM_API_KEY: key,
      // The pinned 1.17.x engine gates model availability on integration connections; the zai
      // integrations declare an env method via ZHIPU_API_KEY (verified live via
      // GET /api/integration). Env-only: the key never touches disk.
      ZHIPU_API_KEY: key,
    };
    this.child = spawn(bin.path, [
      "serve",
      "--port", String(ENGINE_PORT),
      "--hostname", LOOPBACK,
      "--pure",
      "--print-logs",
      "--log-level", "INFO",
    ], { cwd: RUNTIME_ROOT, env, stdio: ["ignore", logFd, logFd], detached: false });

    const pid = this.child.pid ?? -1;
    await this.waitHealthy(30000);
    return { pid, version: bin.version, credential_source: credentialSource };
  }

  async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.runtime.health(AbortSignal.timeout(2000))) return;
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 400));
    }
    throw new Error(`opencode engine did not become healthy on ${this.baseUrl} within ${timeoutMs}ms`);
  }

  async isHealthy(): Promise<boolean> {
    try {
      return await this.runtime.health(AbortSignal.timeout(1500));
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.child && this.child.pid) {
      this.child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 1200));
      if (!this.child.killed || this.child.exitCode === null) {
        try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    this.child = null;
  }

  async createSession(directory: string, providerID: string, modelID: string, agent?: string): Promise<string> {
    return this.runtime.createSession(directory, providerID, modelID, agent);
  }

  async prompt(sessionID: string, text: string): Promise<void> {
    await this.runtime.prompt(sessionID, text);
  }

  /** Mid-run steer through the official SDK delivery enum: steer | queue. */
  async steer(sessionID: string, text: string): Promise<void> {
    await this.runtime.steer(sessionID, text);
  }

  /**
   * Long-lived subscription to the engine's /event SSE stream. Reconnects with
   * backoff until stop() flips. Each parsed JSON frame is passed to onEvent.
   */
  subscribeEvents(onEvent: (evt: unknown) => void): { stop: () => void } {
    return this.runtime.subscribeEvents(onEvent);
  }

  async setSessionModel(sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.runtime.switchModel(sessionID, providerID, modelID);
  }

  async abortSession(sessionID: string): Promise<void> {
    await this.runtime.abortSession(sessionID);
  }

  /** True when the session has at least one assistant turn (i.e. work actually ran). */
  async hasAssistantTurn(sessionID: string): Promise<boolean> {
    const msgs = (await this.messages(sessionID)) as Array<Record<string, unknown>>;
    return containsAssistantTurn(msgs ?? []);
  }

  /**
   * Blocks until the session goes idle. POST /wait returns 503 "not available
   * yet" in the original 1.17.15 seam proof, so idle = the newest message is a
   * completed assistant message, no pending permission requests, stable for
   * three consecutive polls. Throws if the final assistant turn errored.
   */
  async waitIdle(sessionID: string, timeoutMs = 600000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    let lastSig = "";
    let messageErrors = 0;
    let permissionErrors = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      let msgs: Array<Record<string, unknown>>;
      try {
        msgs = await this.messages(sessionID) as Array<Record<string, unknown>>;
        messageErrors = 0;
      } catch (error) {
        messageErrors += 1;
        if (messageErrors >= 3) {
          const abortDetail = await this.abortDetail(sessionID);
          throw new Error(
            `session ${sessionID} message polling failed ${messageErrors} consecutive times: ${error instanceof Error ? error.message : String(error)}; ${abortDetail}`,
            { cause: error },
          );
        }
        continue;
      }
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const last = newestMessage(msgs);
      if (!last) continue;
      const time = (last.time ?? {}) as Record<string, unknown>;
      const isCompletedAssistant = isTerminalAssistant(last);
      let pendingPerms = 0;
      try {
        pendingPerms = (await this.pendingPermissions(sessionID)).length;
        permissionErrors = 0;
      } catch (error) {
        permissionErrors += 1;
        stable = 0;
        if (permissionErrors >= 3) {
          const abortDetail = await this.abortDetail(sessionID);
          throw new Error(
            `session ${sessionID} permission polling failed ${permissionErrors} consecutive times: ${error instanceof Error ? error.message : String(error)}; ${abortDetail}`,
            { cause: error },
          );
        }
        continue;
      }
      const sig = `${String(last.id)}:${String(time.completed ?? "")}`;
      if (isCompletedAssistant && pendingPerms === 0 && sig === lastSig) {
        stable += 1;
        if (stable >= 3) {
          if (last.finish === "error") {
            const err = (last.error ?? {}) as Record<string, unknown>;
            throw new Error(`engine turn errored: ${String(err.message ?? JSON.stringify(err)).slice(0, 300)}`);
          }
          return msgs;
        }
      } else {
        stable = 0;
        lastSig = sig;
      }
    }
    // A deadline is a circuit-break event, not just a bookkeeping failure.
    // Stop upstream model/tool work before releasing the worktree lease so a
    // failed run cannot continue consuming tokens or mutating abandoned state.
    const abortDetail = await this.abortDetail(sessionID);
    throw new Error(`session ${sessionID} did not go idle within ${timeoutMs}ms; ${abortDetail}`);
  }

  private async abortDetail(sessionID: string): Promise<string> {
    try {
      await this.abortSession(sessionID);
      return "upstream session aborted";
    } catch (error) {
      return `upstream abort failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async pendingPermissions(sessionID: string): Promise<Array<Record<string, unknown>>> {
    return this.runtime.pendingPermissions(sessionID);
  }

  async replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): Promise<void> {
    await this.runtime.replyPermission(sessionID, requestID, reply);
  }

  async messages(sessionID: string): Promise<unknown> {
    return this.runtime.messages(sessionID);
  }

  /** Answer a question request: answers = one array of selected labels per question. */
  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void> {
    await this.runtime.replyQuestion(sessionID, requestID, answers);
  }

  async pendingQuestions(sessionID: string): Promise<Array<Record<string, unknown>>> {
    return this.runtime.pendingQuestions(sessionID);
  }
}
