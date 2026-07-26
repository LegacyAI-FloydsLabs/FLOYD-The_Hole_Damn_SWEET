import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Config is read at import time. Isolate this acceptance server from the live
// workstation so a failed test cannot switch the user's active experience.
const runtimeRoot = mkdtempSync(join(tmpdir(), "floyd-five-surface-"));
chmodSync(runtimeRoot, 0o700);
mkdirSync(join(runtimeRoot, "core"), { recursive: true, mode: 0o700 });
process.env.FLOYD_RUNTIME_ROOT = runtimeRoot;
process.env.FLOYD_CORE_PORT = "0";
process.env.FLOYD_REMOTE_CORE_PORT = "0";
process.env.FLOYD_REMOTE_ORIGIN = "https://floyd.test";

// Resolve Core through computed file URLs. This remains a true integration
// test at runtime without pulling Core's source tree into the SDK composite
// TypeScript project (whose rootDir is intentionally packages/sdk).
const repositoryRoot = join(import.meta.dirname, "../../..");
const coreModuleUrl = (file: string) => pathToFileURL(join(repositoryRoot, "core/daemon/src", file)).href;
const { openDb } = await import(coreModuleUrl("db.ts"));
const { gatewayToken } = await import(coreModuleUrl("config.ts"));
const { startGateway } = await import(coreModuleUrl("http.ts"));

type PortableClient = {
  negotiateExperience(input: {
    surface_id: string;
    capabilities: string[];
    sdk_version: string;
    supported_envelope_versions: string[];
  }, signal?: AbortSignal): Promise<{ accepted: boolean }>;
  experience(envelopeId?: string, signal?: AbortSignal): Promise<PortableEnvelope>;
  updateExperience(envelopeId: string, patch: Record<string, unknown>, signal?: AbortSignal): Promise<PortableEnvelope>;
};

type PortableEnvelope = {
  id: string;
  revision: number;
  composer_draft: string;
  selected_view: string;
  surfaces: Record<string, { capabilities: string[] }>;
};

interface SurfaceModule {
  FloydClient?: new (options: Record<string, unknown>) => PortableClient;
  default?: { FloydClient?: new (options: Record<string, unknown>) => PortableClient };
}

const surfaceModules = [
  ["desktop", "intake/surfaces/desktop/vendor/floyd-sdk/index.js"],
  ["ide", "intake/surfaces/ide/vendor/floyd-sdk/index.js"],
  ["tui", "intake/surfaces/tui/packages/floyd-sdk/src/index.ts"],
  ["pty", "intake/surfaces/pty/vendor/floyd-sdk/index.js"],
  ["launcher", "intake/surfaces/launcher/vendor/floyd-sdk/index.js"],
] as const;

const db = openDb(join(runtimeRoot, "core", "five-surface.db"));
const engine = {
  isHealthy: async () => true,
  baseUrl: "http://127.0.0.1:9",
  child: null,
  messages: async () => [],
  pendingPermissions: async () => [],
  pendingQuestions: async () => [],
  replyPermission: async () => {},
  replyQuestion: async () => {},
  steer: async () => {},
} as never;
const server = startGateway(db, engine, process.pid, new Date().toISOString());
if (!server.listening) await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("five-surface acceptance server did not bind TCP");
const baseUrl = `http://127.0.0.1:${address.port}`;
const token = gatewayToken();

async function loadClients(): Promise<Array<{ id: string; client: PortableClient }>> {
  const clients: Array<{ id: string; client: PortableClient }> = [];
  for (const [id, relativePath] of surfaceModules) {
    const module = await import(pathToFileURL(join(repositoryRoot, relativePath)).href) as SurfaceModule;
    const Client = module.FloydClient ?? module.default?.FloydClient;
    assert.ok(Client, `${id} copied SDK must export FloydClient`);
    clients.push({ id, client: new Client({ baseUrl, token }) });
  }
  return clients;
}

test("all five copied surface SDKs restore one authoritative experience", async (t) => {
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    db.close();
  });

  const clients = await loadClients();
  for (const { id, client } of clients) {
    const negotiation = await client.negotiateExperience({
      surface_id: id,
      capabilities: ["active-context", "experience-stream"],
      sdk_version: "1.0.0",
      supported_envelope_versions: ["1.0.0"],
    });
    assert.equal(negotiation.accepted, true, `${id} negotiation rejected`);
  }

  const restored = await Promise.all(clients.map(({ client }) => client.experience("primary")));
  assert.equal(new Set(restored.map((envelope) => envelope.id)).size, 1);
  assert.equal(new Set(restored.map((envelope) => envelope.revision)).size, 1);
  for (const { id } of clients) assert.ok(restored[0]!.surfaces[id], `${id} presence was not registered`);

  const marker = `five-surface-${process.pid}`;
  const published = await clients[0]!.client.updateExperience("primary", {
    expected_revision: restored[0]!.revision,
    composer_draft: marker,
    selected_view: "desktop",
  });
  const observed = await Promise.all(clients.slice(1).map(({ client }) => client.experience("primary")));
  for (const envelope of observed) {
    assert.equal(envelope.revision, published.revision);
    assert.equal(envelope.composer_draft, marker);
    assert.equal(envelope.selected_view, "desktop");
  }

  // A surface holding the pre-publication revision must not overwrite the
  // portable state it just observed from another client.
  await assert.rejects(
    clients[1]!.client.updateExperience("primary", {
      expected_revision: restored[1]!.revision,
      composer_draft: "stale-overwrite",
    }),
    (error: unknown) => {
      const conflict = error as { status?: number; payload?: { error?: string; envelope?: PortableEnvelope } };
      assert.equal(conflict.status, 409);
      assert.equal(conflict.payload?.error, "revision_conflict");
      assert.equal(conflict.payload?.envelope?.composer_draft, marker);
      return true;
    },
  );
});
