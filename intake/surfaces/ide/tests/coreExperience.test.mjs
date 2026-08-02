// @vitest-environment node
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoreExperience, IDE_SURFACE_ID } from '../server/core-experience.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
});

function makeRuntimeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cursem-core-experience-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  writeFileSync(join(root, 'core', 'gateway.token'), 'test-gateway-token');
  return root;
}

function makeEnvelope(overrides = {}) {
  return {
    id: 'primary',
    schema_version: '1.0.0',
    revision: 1,
    active: { project_id: null, session_id: null, run_id: null },
    model_route: { provider: 'zai', model: 'glm-4.8', base_url: null, provider_profile_id: 'coding-plan', credential_ref: 'keychain://zai' },
    transcript_cursor: 0,
    transcript_epoch: null,
    last_event_id: null,
    pending_questions: [],
    pending_permissions: [],
    composer_draft: 'draft from tui',
    selected_artifact_id: null,
    selected_view: 'tui:run',
    surfaces: {},
    updated_at: '2026-07-31T12:00:00.000Z',
    updated_by_device_id: 'dev_test',
    ...overrides,
  };
}

/** Minimal Floyd Core experience API double with optimistic revision checks. */
async function listenFakeCore(envelope, { projects = [] } = {}) {
  const state = {
    envelope,
    projects: [...projects],
    negotiations: [],
    patchBodies: [],
    createdProjects: [],
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (req.headers.authorization !== 'Bearer test-gateway-token') return send(401, { error: 'unauthorized' });
    const body = Buffer.concat(await Array.fromAsync(req)).toString('utf8');
    if (req.url === '/api/experience/negotiate' && req.method === 'POST') {
      state.negotiations.push(JSON.parse(body));
      return send(200, { accepted: true, envelope_version: '1.0.0', core_protocol_version: '1.0.0' });
    }
    if (req.url === '/api/experience/primary' && req.method === 'GET') return send(200, state.envelope);
    if (req.url === '/api/experience/primary' && req.method === 'PATCH') {
      const patch = JSON.parse(body);
      state.patchBodies.push(patch);
      if (patch.expected_revision !== state.envelope.revision) {
        return send(409, { error: 'revision conflict', actual_revision: state.envelope.revision, envelope: state.envelope });
      }
      const mergedRoute = { ...state.envelope.model_route, ...(patch.model_route || {}) };
      state.envelope = {
        ...state.envelope,
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        model_route: mergedRoute,
        ...(patch.composer_draft !== undefined ? { composer_draft: patch.composer_draft } : {}),
        revision: state.envelope.revision + 1,
        ...(patch.surface ? { surfaces: { ...state.envelope.surfaces, [patch.surface.surface_id]: patch.surface } } : {}),
      };
      return send(200, state.envelope);
    }
    if (req.url === '/api/experience/primary/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      req.once('close', () => res.end());
      return;
    }
    if (req.url === '/api/state' && req.method === 'GET') return send(200, { projects: state.projects, sessions: [], runs: [] });
    if (req.url === '/api/projects' && req.method === 'POST') {
      const created = { id: `prj_${state.createdProjects.length + 1}`, ...JSON.parse(body) };
      state.createdProjects.push(created);
      state.projects.push(created);
      return send(201, { id: created.id });
    }
    return send(404, { error: `no route ${req.method} ${req.url}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

function bridge(url, env = {}) {
  return createCoreExperience({ env: { FLOYD_CORE_URL: url, FLOYD_RUNTIME_ROOT: makeRuntimeRoot(), ...env } });
}

describe('Floyd Core experience bridge', () => {
  it('negotiates as the ide surface and restores a credential-free slice', async () => {
    const { state, url } = await listenFakeCore(makeEnvelope());
    const core = bridge(url);
    const restore = await core.start({ workspaceRoot: '/tmp/unused' });

    expect(restore.available).toBe(true);
    expect(restore.revision).toBe(1);
    expect(restore.modelRoute).toEqual({ provider: 'zai', model: 'glm-4.8' });
    expect(restore.composerDraft).toBe('draft from tui');
    expect(JSON.stringify(restore)).not.toContain('keychain://');
    expect(JSON.stringify(core.snapshot())).not.toContain('keychain://');
    expect(state.negotiations).toHaveLength(1);
    expect(state.negotiations[0].surface_id).toBe(IDE_SURFACE_ID);
    expect(state.negotiations[0].capabilities).toContain('model-route');
    await core.stop();
  });

  it('publishes route and draft optimistically without clobbering other route fields', async () => {
    const { state, url } = await listenFakeCore(makeEnvelope());
    const core = bridge(url);
    await core.start({});

    const result = await core.publishUi({ modelRoute: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, composerDraft: 'hello from the IDE' });
    expect(result.conflict).toBeUndefined();
    expect(result.revision).toBe(2);
    expect(state.envelope.model_route.provider).toBe('anthropic');
    expect(state.envelope.model_route.model).toBe('claude-sonnet-4-6');
    expect(state.envelope.model_route.provider_profile_id).toBe('coding-plan');
    expect(state.envelope.composer_draft).toBe('hello from the IDE');
    expect(state.envelope.surfaces[IDE_SURFACE_ID].surface_id).toBe(IDE_SURFACE_ID);
    await core.stop();
  });

  it('surfaces a 409 after re-reading and never blind-retries over the authoritative draft', async () => {
    const { state, url } = await listenFakeCore(makeEnvelope());
    const core = bridge(url);
    await core.start({});
    state.envelope = { ...state.envelope, revision: 5, composer_draft: 'remote wins' };

    const result = await core.publishUi({ composerDraft: 'stale local edit' });
    expect(result.conflict).toBe(true);
    expect(result.composerDraft).toBe('remote wins');
    expect(state.envelope.composer_draft).toBe('remote wins');
    expect(state.envelope.revision).toBe(5);
    expect(state.patchBodies).toHaveLength(1);
    await core.stop();
  });

  it('degrades to unavailable when Core is unreachable without throwing', async () => {
    const core = bridge('http://127.0.0.1:9');
    const restore = await core.start({ workspaceRoot: '/tmp/unused' });
    expect(restore).toEqual({ available: false });
    expect(core.snapshot()).toEqual({ available: false });
    expect(await core.publishUi({ composerDraft: 'x' })).toEqual({ available: false });
    await core.stop();
  });

  it('registers the workspace as a Core project only while no session is live', async () => {
    const idle = await listenFakeCore(makeEnvelope());
    const idleCore = bridge(idle.url);
    await idleCore.start({});
    await idleCore.publishWorkspace('/tmp/cursem-workspace');
    expect(idleCore.snapshot().active).toEqual({ project_id: 'prj_1', session_id: null, run_id: null });
    expect(idle.state.createdProjects).toEqual([expect.objectContaining({ root_path: '/tmp/cursem-workspace' })]);
    await idleCore.stop();

    const live = await listenFakeCore(makeEnvelope({ active: { project_id: 'prj_9', session_id: 'ses_1', run_id: 'run_1' } }));
    const liveCore = bridge(live.url);
    await liveCore.start({});
    live.state.patchBodies.length = 0;
    await liveCore.publishWorkspace('/tmp/elsewhere');
    expect(live.state.patchBodies.some((patch) => patch.active !== undefined)).toBe(false);
    expect(live.state.envelope.active).toEqual({ project_id: 'prj_9', session_id: 'ses_1', run_id: 'run_1' });
    await liveCore.stop();
  });

  it('publishes a final surface-presence patch on stop', async () => {
    const { state, url } = await listenFakeCore(makeEnvelope());
    const core = bridge(url);
    await core.start({});
    const patchesBefore = state.patchBodies.length;
    await core.stop();
    expect(state.patchBodies.length).toBeGreaterThan(patchesBefore);
    expect(state.patchBodies.at(-1).surface.surface_id).toBe(IDE_SURFACE_ID);
  });
});
