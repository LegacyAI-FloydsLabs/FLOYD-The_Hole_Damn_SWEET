import { verifyRuntimeRoot, nowIso, CORE_PORT, LOOPBACK, PATHS, REMOTE_CORE_PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { OpenCodeEngine } from "./engine.ts";
import { appendEvidence } from "./evidence.ts";
import { seed } from "./seed.ts";
import { recoverInterrupted } from "./runs.ts";
import { startGateway, startLiveChannel, startRemoteGateway, startRemoteSurfaceGateways } from "./http.ts";

// Core owns credentials, SQLite state, and managed-engine state. Keep every
// newly created runtime file private even outside launchd (for example, a
// foreground diagnostic start).
process.umask(0o077);

async function main(): Promise<void> {
  const startedAt = nowIso();
  verifyRuntimeRoot();
  const db = openDb();
  seed(db);
  recoverInterrupted(db);

  const engine = new OpenCodeEngine();
  const bin = engine.verifyBinary();
  appendEvidence(db, "core.starting", "floyd-core", {
    pid: process.pid,
    core: `${LOOPBACK}:${CORE_PORT}`,
    engine_binary: bin,
    runtime_root: PATHS.coreDir,
  });

  const { pid, version, credential_source } = await engine.start();
  appendEvidence(db, "engine.started", "floyd-core", {
    pid,
    version,
    url: engine.baseUrl,
    pure: true,
    isolation: "XDG+OPENCODE_CONFIG under FLOYD_RUNTIME",
    credential_source,
    credential_note:
      credential_source === "omp-auth-broker:zai"
        ? "canonical broker credential"
        : "broker zai credential failed validation (HTTP 401, 2026-07-12); using validated user opencode config key for the same GLM Coding Plan — refresh the broker credential",
  });

  const localGateway = startGateway(db, engine, process.pid, startedAt);
  const remoteGateway = startRemoteGateway(db, engine, process.pid, startedAt);
  const remoteSurfaceGateways = startRemoteSurfaceGateways(db);
  const live = startLiveChannel(db, engine);
  appendEvidence(db, "core.gateway_listening", "floyd-core", { url: `http://${LOOPBACK}:${CORE_PORT}`, live_channel: true });
  appendEvidence(db, "core.remote_gateway_listening", "floyd-core", { url: `http://${LOOPBACK}:${REMOTE_CORE_PORT}`, device_sessions: true });
  appendEvidence(db, "core.remote_surface_gateways_listening", "floyd-core", {
    surfaces: remoteSurfaceGateways.map(({ id, relayPort, publicOrigin }) => ({ id, relay: `http://${LOOPBACK}:${relayPort}`, public_origin: publicOrigin })),
    device_sessions: true,
  });
  console.log(`[floyd-core] up pid=${process.pid} gateway=http://${LOOPBACK}:${CORE_PORT} remote=http://${LOOPBACK}:${REMOTE_CORE_PORT} engine=${engine.baseUrl} (opencode ${version} pid=${pid})`);

  const shutdown = async (sig: string) => {
    appendEvidence(db, "core.shutdown", "floyd-core", { signal: sig });
    live.stop();
    localGateway.close();
    remoteGateway.close();
    for (const { server } of remoteSurfaceGateways) server.close();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[floyd-core] fatal:", err);
  process.exit(1);
});
