import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { FloydApiError, FloydClient, FLOYD_SDK_PROTOCOL_VERSION } from '../vendor/floyd-sdk/index.js';

export const IDE_SURFACE_ID = 'ide';
// Union of the surface registry's restore/publish claims for the IDE.
export const IDE_CAPABILITIES = Object.freeze([
  'active-context',
  'composer-draft',
  'durable-transcript',
  'workspace',
  'selected-artifact',
  'pending-questions',
  'pending-permissions',
  'model-route',
  'selected-view',
  'surface-presence',
]);

const MAX_DRAFT_LENGTH = 262_144;

function resolveCoreUrl(env) {
  return env.FLOYD_CORE_URL || `http://127.0.0.1:${env.FLOYD_CORE_PORT || 41414}`;
}

/**
 * Server-side bridge to Floyd Core's experience sync. The gateway token never
 * leaves the loopback server; the browser only sees the sanitized snapshot().
 *
 * Publication semantics mirror the TUI's FloydExperienceCoordinator: mutations
 * are serialized and optimistic, and a 409 refreshes local truth and is
 * surfaced to the caller — never retried blindly over another surface's
 * authoritative state. Every Core failure degrades to available:false without
 * blocking the IDE boot or the chat path.
 */
export function createCoreExperience({ env = process.env, fetchImpl } = {}) {
  const runtimeRoot = env.FLOYD_RUNTIME_ROOT || join(homedir(), '.floyd');
  const tokenPath = join(runtimeRoot, 'core', 'gateway.token');
  const client = new FloydClient({
    baseUrl: resolveCoreUrl(env),
    token: () => readFileSync(tokenPath, 'utf8').trim(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  let envelope = null;
  let available = false;
  let closed = false;
  let publishTail = Promise.resolve();
  let watchAbort = null;
  let watchTask = null;

  function surfaceRecord(base) {
    return {
      surface_id: IDE_SURFACE_ID,
      sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
      capabilities: [...IDE_CAPABILITIES],
      transcript_cursor: base?.transcript_cursor ?? 0,
      transcript_epoch: base?.transcript_epoch ?? null,
      last_event_id: base?.last_event_id ?? null,
    };
  }

  /** Browser-safe slice: never forwards model_route.credential_ref. */
  function snapshot() {
    if (!available || !envelope) return { available: false };
    const route = envelope.model_route || {};
    return {
      available: true,
      revision: envelope.revision,
      modelRoute: route.provider && route.model ? { provider: route.provider, model: route.model } : null,
      composerDraft: typeof envelope.composer_draft === 'string' ? envelope.composer_draft : '',
      active: envelope.active || null,
    };
  }

  async function refresh(signal) {
    envelope = await client.experience('primary', signal);
    available = true;
    return envelope;
  }

  async function resolveActiveWorkspaceRoot() {
    const projectId = envelope?.active?.project_id;
    if (!projectId) return null;
    const state = await client.state();
    const project = (Array.isArray(state.projects) ? state.projects : []).find((candidate) => candidate.id === projectId);
    return typeof project?.root_path === 'string' && project.root_path ? project.root_path : null;
  }

  function publish(change) {
    const operation = async () => {
      if (closed) throw new Error('Core experience bridge is closed.');
      const base = envelope ?? (await refresh());
      try {
        const next = await client.updateExperience('primary', {
          expected_revision: base.revision,
          ...change,
          surface: surfaceRecord(base),
        });
        if (!envelope || next.revision >= envelope.revision) envelope = next;
        available = true;
        return envelope;
      } catch (error) {
        // Refresh local truth for recovery, but preserve the original conflict.
        envelope = await client.experience('primary').catch(() => base);
        throw error;
      }
    };
    const queued = publishTail.then(operation, operation);
    publishTail = queued.catch(() => undefined);
    return queued;
  }

  /** Publish a browser-originated model-route and/or composer-draft change. */
  async function publishUi(change) {
    if (!available) return { available: false };
    const patch = {};
    const route = change?.modelRoute;
    if (route && typeof route.provider === 'string' && route.provider && typeof route.model === 'string' && route.model) {
      // Core merges model_route subfields; the other route keys are preserved.
      patch.model_route = { provider: route.provider, model: route.model };
    }
    if (typeof change?.composerDraft === 'string') patch.composer_draft = change.composerDraft.slice(0, MAX_DRAFT_LENGTH);
    if (!Object.keys(patch).length) return snapshot();
    try {
      await publish(patch);
      return snapshot();
    } catch (error) {
      if (error instanceof FloydApiError && error.status === 409) return { ...snapshot(), conflict: true };
      return { ...snapshot(), available: false };
    }
  }

  /**
   * Workspace continuity rides Core projects: the envelope carries only the
   * active context, so the root is registered as a project and published as
   * the active project only while no surface owns a live session/run — the
   * IDE never detaches another surface's session.
   */
  async function publishWorkspace(rootPath) {
    if (!available || typeof rootPath !== 'string' || !rootPath) return;
    const state = await client.state();
    const existing = (Array.isArray(state.projects) ? state.projects : []).find((candidate) => candidate.root_path === rootPath);
    const projectId = existing?.id
      || (await client.request('POST', '/api/projects', { name: basename(rootPath) || rootPath, root_path: rootPath })).id;
    const active = envelope?.active || {};
    if (active.project_id === projectId || active.session_id || active.run_id) return;
    await publish({ active: { project_id: projectId, session_id: null, run_id: null } });
  }

  function startWatch() {
    const controller = new AbortController();
    watchAbort = controller;
    let failures = 0;
    const task = (async () => {
      while (!controller.signal.aborted && !closed) {
        try {
          if (failures > 0) {
            // A fresh GET is authoritative even when Core was restored to a
            // lower revision than this process previously observed.
            const restored = await client.experience('primary', controller.signal);
            if (!envelope || restored.revision !== envelope.revision) envelope = restored;
          }
          for await (const event of client.watchExperience('primary', { lastEventId: String(envelope?.revision ?? 0), signal: controller.signal })) {
            if (controller.signal.aborted || closed || event.type !== 'experience') continue;
            const next = event.data;
            if (!next || typeof next.revision !== 'number') continue;
            if (envelope && next.revision <= envelope.revision) continue;
            failures = 0;
            envelope = next;
          }
          if (!controller.signal.aborted && !closed) throw new Error('Floyd experience stream ended');
        } catch {
          if (controller.signal.aborted || closed) return;
          failures += 1;
          const delay = Math.min(150 * 2 ** Math.min(failures - 1, 6), 2_000);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      }
    })();
    watchTask = task.catch(() => undefined);
  }

  async function start({ workspaceRoot } = {}) {
    try {
      const negotiation = await client.negotiateExperience({
        surface_id: IDE_SURFACE_ID,
        sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
        capabilities: [...IDE_CAPABILITIES],
      });
      if (!negotiation.accepted) throw new Error(negotiation.reason || 'Floyd experience protocol rejected this SDK.');
      await refresh();
      startWatch();
      const restore = snapshot();
      restore.workspaceRoot = await resolveActiveWorkspaceRoot().catch(() => null);
      if (workspaceRoot) await publishWorkspace(workspaceRoot).catch(() => undefined);
      return restore;
    } catch {
      available = false;
      return { available: false };
    }
  }

  async function stop() {
    if (closed) return;
    closed = true;
    watchAbort?.abort();
    await watchTask;
    await publishTail.catch(() => undefined);
    // Surface-presence on shutdown: one bounded best-effort presence publish.
    try {
      const base = envelope ?? (await refresh(AbortSignal.timeout(1_500)));
      await client.updateExperience('primary', { expected_revision: base.revision, surface: surfaceRecord(base) }, AbortSignal.timeout(1_500));
    } catch { /* Core may already be gone; shutdown must not block on it. */ }
  }

  return {
    start,
    snapshot,
    publishUi,
    publishWorkspace,
    stop,
    get available() { return available; },
  };
}
