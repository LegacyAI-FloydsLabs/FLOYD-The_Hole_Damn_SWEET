import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopExperienceCoordinator,
  FloydCoreApiError,
  desktopProviderForRoute,
} from './floyd-core-experience.js';

const CORE = 'http://127.0.0.1:41414';
const TOKEN = 'test-gateway-token';

function envelope(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'primary',
    schema_version: '1.0.0',
    revision,
    active: { project_id: 'proj-1', session_id: 'sess-1', run_id: 'run-1' },
    model_route: { provider: 'zai', model: 'glm-5.2', base_url: null, provider_profile_id: null, credential_ref: null },
    connected_app_ids: [],
    transcript_cursor: 12,
    transcript_epoch: 'epoch-1',
    last_event_id: 'evt-9',
    pending_questions: [],
    pending_permissions: [],
    composer_draft: 'draft typed on another surface',
    selected_artifact_id: null,
    selected_view: 'chat',
    surfaces: {},
    updated_at: '2026-07-31T00:00:00.000Z',
    updated_by_device_id: null,
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body?: any };

function coreFetch(handlers: Record<string, (call: FetchCall) => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const call: FetchCall = { url, method, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = `${method} ${url.replace(CORE, '')}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected Core call: ${key}`);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe('Desktop Floyd Core experience sync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('negotiates as surface desktop and restores the portable state', async () => {
    const { fetchImpl, calls } = coreFetch({
      'POST /api/experience/negotiate': () => Response.json({ accepted: true, envelope_version: '1.0.0' }),
      'GET /api/experience/primary': () => Response.json(envelope(7)),
    });
    const coordinator = new DesktopExperienceCoordinator({ baseUrl: CORE, token: TOKEN, fetchImpl });

    const state = await coordinator.start({ watch: false });

    expect(state).toEqual({
      revision: 7,
      composerDraft: 'draft typed on another surface',
      modelRoute: { provider: 'zai', model: 'glm-5.2' },
      active: { project_id: 'proj-1', session_id: 'sess-1', run_id: 'run-1' },
      selectedView: 'chat',
    });
    expect(calls[0].url).toBe(`${CORE}/api/experience/negotiate`);
    expect(calls[0].body).toMatchObject({ surface_id: 'desktop', sdk_version: '1.0.0' });
    expect(calls[0].body.capabilities).toContain('composer-draft');
    expect(coordinator.available).toBe(true);
    await coordinator.stop();
  });

  it('sends the gateway token as a Bearer credential', async () => {
    let seenAuth: string | undefined;
    const fetchImpl = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      seenAuth = init?.headers?.authorization;
      const url = String(input);
      if (url.endsWith('/negotiate')) return Response.json({ accepted: true });
      return Response.json(envelope(1));
    }) as unknown as typeof globalThis.fetch;
    const coordinator = new DesktopExperienceCoordinator({ baseUrl: CORE, token: TOKEN, fetchImpl });

    await coordinator.start({ watch: false });
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    await coordinator.stop();
  });

  it('throws (so boot can degrade) when Core rejects the protocol or is unreachable', async () => {
    const rejected = new DesktopExperienceCoordinator({
      baseUrl: CORE,
      token: TOKEN,
      fetchImpl: vi.fn(async () => Response.json({ accepted: false, reason: 'unsupported envelope' })) as unknown as typeof globalThis.fetch,
    });
    await expect(rejected.start({ watch: false })).rejects.toThrow(/unsupported envelope/);
    expect(rejected.available).toBe(false);

    const down = new DesktopExperienceCoordinator({
      baseUrl: CORE,
      token: TOKEN,
      fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof globalThis.fetch,
    });
    await expect(down.start({ watch: false })).rejects.toThrow(/ECONNREFUSED/);
    expect(down.available).toBe(false);

    // Publications are no-ops while unavailable.
    down.publish({ composer_draft: 'ignored' });
    await down.stop();
  });

  it('maps Core model_route providers to Desktop providers', () => {
    expect(desktopProviderForRoute('zai')).toBe('glm');
    expect(desktopProviderForRoute('anthropic')).toBe('anthropic');
    expect(desktopProviderForRoute('openai')).toBe('openai');
    expect(desktopProviderForRoute('deepseek')).toBeNull();
    expect(desktopProviderForRoute('auto')).toBeNull();
    expect(desktopProviderForRoute(null)).toBeNull();
  });

  it('publishes drafts optimistically and coalesces rapid changes', async () => {
    const patchCalls: FetchCall[] = [];
    const { fetchImpl } = coreFetch({
      'POST /api/experience/negotiate': () => Response.json({ accepted: true }),
      'GET /api/experience/primary': () => Response.json(envelope(3)),
      'PATCH /api/experience/primary': (call) => {
        patchCalls.push(call);
        return Response.json(envelope(4, { composer_draft: call.body.composer_draft, revision: 4 }));
      },
    });
    const coordinator = new DesktopExperienceCoordinator({ baseUrl: CORE, token: TOKEN, fetchImpl });
    await coordinator.start({ watch: false });

    vi.useFakeTimers();
    coordinator.publish({ composer_draft: 'first' });
    coordinator.publish({ composer_draft: 'second' });
    await vi.advanceTimersByTimeAsync(500);
    await coordinator.stop();

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].body).toMatchObject({
      expected_revision: 3,
      composer_draft: 'second',
      surface: {
        surface_id: 'desktop',
        sdk_version: '1.0.0',
        transcript_cursor: 12,
        transcript_epoch: 'epoch-1',
        last_event_id: 'evt-9',
      },
    });
    expect(coordinator.state?.revision).toBe(4);
  });

  it('preserves a 409 conflict: re-reads the envelope and rethrows without blind retry', async () => {
    let patchCount = 0;
    const errors: unknown[] = [];
    const restoredStates: Array<{ revision: number }> = [];
    const { fetchImpl } = coreFetch({
      'POST /api/experience/negotiate': () => Response.json({ accepted: true }),
      'GET /api/experience/primary': (() => {
        let gets = 0;
        return () => {
          gets += 1;
          // First GET is the boot read; the conflict recovery re-read sees a
          // newer revision written by another surface.
          return Response.json(gets === 1 ? envelope(3) : envelope(5, { composer_draft: 'their draft' }));
        };
      })(),
      'PATCH /api/experience/primary': () => {
        patchCount += 1;
        return new Response(JSON.stringify({ error: { type: 'revision_conflict', revision: 5 } }), { status: 409 });
      },
    });
    const coordinator = new DesktopExperienceCoordinator({
      baseUrl: CORE,
      token: TOKEN,
      fetchImpl,
      onError: (error) => errors.push(error),
      onEnvelope: (state) => restoredStates.push(state),
    });
    await coordinator.start({ watch: false });

    vi.useFakeTimers();
    coordinator.publish({ composer_draft: 'my draft' });
    await vi.advanceTimersByTimeAsync(500);
    await coordinator.stop();

    expect(patchCount).toBe(1); // never retried blind over authoritative state
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FloydCoreApiError);
    expect((errors[0] as FloydCoreApiError).status).toBe(409);
    expect(coordinator.state?.revision).toBe(5);
    expect(coordinator.state?.composerDraft).toBe('their draft');
    expect(restoredStates.at(-1)?.revision).toBe(5);
  });

  it('flushes a pending debounced publication on stop', async () => {
    const patchCalls: FetchCall[] = [];
    const { fetchImpl } = coreFetch({
      'POST /api/experience/negotiate': () => Response.json({ accepted: true }),
      'GET /api/experience/primary': () => Response.json(envelope(2)),
      'PATCH /api/experience/primary': (call) => {
        patchCalls.push(call);
        return Response.json(envelope(3));
      },
    });
    const coordinator = new DesktopExperienceCoordinator({ baseUrl: CORE, token: TOKEN, fetchImpl });
    await coordinator.start({ watch: false });

    vi.useFakeTimers();
    coordinator.publish({ selected_view: 'browork' });
    await coordinator.stop(); // no debounce wait: shutdown must not lose it

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].body).toMatchObject({ expected_revision: 2, selected_view: 'browork' });
  });
});
