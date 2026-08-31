/**
 * Floyd Core experience sync (P5 continuity) for the Desktop surface.
 *
 * Speaks the same protocol as the vendored @floyd/sdk snapshot
 * (vendor/floyd-sdk/index.js) directly over fetch, in the style of the other
 * server modules: dependency-injected fetch, soft parsing, never throws into
 * boot. Mirrors the TUI's FloydExperienceCoordinator semantics:
 * negotiate -> read envelope -> watch with reconnect; publications are
 * serialized and optimistic, and a 409 revision conflict is preserved and
 * re-read, never blind-retried over another surface's authoritative state.
 *
 * Auth: Core's local boundary accepts the gateway token as a Bearer
 * credential (core/daemon/src/http.ts). The token is read from
 * $FLOYD_RUNTIME_ROOT/core/gateway.token and never logged.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const DESKTOP_SURFACE_ID = 'desktop';
const FLOYD_EXPERIENCE_VERSION = '1.0.0';
const FLOYD_SDK_PROTOCOL_VERSION = '1.0.0';
const ENVELOPE_ID = 'primary';
/** Matches the ecosystem registry restore/publish declaration for desktop. */
export const DESKTOP_CAPABILITIES = [
  'active-context',
  'composer-draft',
  'durable-transcript',
  'selected-artifact',
  'pending-questions',
  'pending-permissions',
  'model-route',
  'selected-view',
  'surface-presence',
  'experience-stream',
] as const;
/** composer_draft cap enforced by Core (core/daemon/src/experience.ts). */
const MAX_DRAFT_LENGTH = 262_144;
const BOOT_TIMEOUT_MS = 3000;
const PUBLISH_DEBOUNCE_MS = 400;

export interface ExperienceActiveContext {
  project_id: string | null;
  session_id: string | null;
  run_id: string | null;
}

export interface DesktopExperienceState {
  revision: number;
  composerDraft: string;
  modelRoute: { provider: string | null; model: string | null };
  active: ExperienceActiveContext;
  selectedView: string | null;
}

interface ExperienceEnvelope {
  revision: number;
  active: ExperienceActiveContext;
  model_route: { provider: string | null; model: string | null };
  composer_draft: string;
  selected_view: string;
  transcript_cursor: number;
  transcript_epoch: string | null;
  last_event_id: string | null;
}

export class FloydCoreApiError extends Error {
  readonly status: number;
  constructor(method: string, route: string, status: number, payload: unknown) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    super(`${method} ${route} -> ${status}: ${detail}`);
    this.name = 'FloydCoreApiError';
    this.status = status;
  }
}

export function defaultCoreBaseUrl(): string {
  return (process.env.FLOYD_CORE_URL || `http://127.0.0.1:${process.env.FLOYD_CORE_PORT || 41414}`).replace(/\/+$/, '');
}

export async function readGatewayToken(runtimeRoot = process.env.FLOYD_RUNTIME_ROOT || path.join(os.homedir(), '.floyd')): Promise<string> {
  return (await fs.readFile(path.join(runtimeRoot, 'core', 'gateway.token'), 'utf8')).trim();
}

/**
 * Map a Core model_route provider to a Desktop provider, or null when the
 * route cannot be honored here (subscription-only or unknown providers).
 */
export function desktopProviderForRoute(provider: string | null): 'anthropic' | 'openai' | 'glm' | null {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  if (provider === 'zai') return 'glm';
  return null;
}

function parseEnvelope(payload: unknown): ExperienceEnvelope {
  const raw = payload as Record<string, unknown>;
  if (!raw || typeof raw.revision !== 'number') throw new Error('Core experience envelope is invalid');
  const active = (raw.active ?? {}) as Record<string, unknown>;
  const route = (raw.model_route ?? {}) as Record<string, unknown>;
  return {
    revision: raw.revision,
    active: {
      project_id: typeof active.project_id === 'string' ? active.project_id : null,
      session_id: typeof active.session_id === 'string' ? active.session_id : null,
      run_id: typeof active.run_id === 'string' ? active.run_id : null,
    },
    model_route: {
      provider: typeof route.provider === 'string' ? route.provider : null,
      model: typeof route.model === 'string' ? route.model : null,
    },
    composer_draft: typeof raw.composer_draft === 'string' ? raw.composer_draft : '',
    selected_view: typeof raw.selected_view === 'string' ? raw.selected_view : 'chat',
    transcript_cursor: typeof raw.transcript_cursor === 'number' ? raw.transcript_cursor : 0,
    transcript_epoch: typeof raw.transcript_epoch === 'string' ? raw.transcript_epoch : null,
    last_event_id: typeof raw.last_event_id === 'string' ? raw.last_event_id : null,
  };
}

export interface DesktopExperienceCoordinatorOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof globalThis.fetch;
  onEnvelope?: (state: DesktopExperienceState) => void;
  onError?: (error: unknown) => void;
}

/**
 * Owns the portable-envelope transport for Desktop. `start()` throws when
 * Core is unreachable or rejects the protocol; the caller degrades and every
 * publish becomes a no-op so boot and chat are never blocked by Core.
 */
export class DesktopExperienceCoordinator {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onEnvelope: (state: DesktopExperienceState) => void;
  private readonly onError: (error: unknown) => void;
  private envelope: ExperienceEnvelope | null = null;
  private publishTail: Promise<unknown> = Promise.resolve();
  private watchAbort: AbortController | null = null;
  private watchTask: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Record<string, unknown> = {};
  private closed = false;

  constructor(options: DesktopExperienceCoordinatorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onEnvelope = options.onEnvelope ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  get available(): boolean {
    return this.envelope !== null && !this.closed;
  }

  get state(): DesktopExperienceState | null {
    return this.envelope ? DesktopExperienceCoordinator.toState(this.envelope) : null;
  }

  private static toState(envelope: ExperienceEnvelope): DesktopExperienceState {
    return {
      revision: envelope.revision,
      composerDraft: envelope.composer_draft,
      modelRoute: { provider: envelope.model_route.provider, model: envelope.model_route.model },
      active: { ...envelope.active },
      selectedView: envelope.selected_view,
    };
  }

  private async request(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let payload: unknown = text;
    if (text) {
      try { payload = JSON.parse(text); } catch { /* Preserve exact non-JSON Core body. */ }
    }
    if (!response.ok) throw new FloydCoreApiError(method, route, response.status, payload);
    return payload;
  }

  /** Negotiate, read the envelope, and start the reconnecting watch. */
  async start(options: { watch?: boolean } = {}): Promise<DesktopExperienceState> {
    const negotiation = await this.request('POST', '/api/experience/negotiate', {
      surface_id: DESKTOP_SURFACE_ID,
      sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
      supported_envelope_versions: [FLOYD_EXPERIENCE_VERSION],
      capabilities: [...DESKTOP_CAPABILITIES],
    }, AbortSignal.timeout(BOOT_TIMEOUT_MS)) as { accepted?: boolean; reason?: string };
    if (!negotiation.accepted) {
      throw new Error(negotiation.reason || 'Floyd Core rejected the Desktop experience protocol');
    }
    this.envelope = parseEnvelope(await this.request(
      'GET', `/api/experience/${ENVELOPE_ID}`, undefined, AbortSignal.timeout(BOOT_TIMEOUT_MS)));
    this.onEnvelope(DesktopExperienceCoordinator.toState(this.envelope));
    if (options.watch !== false) this.startWatch();
    return DesktopExperienceCoordinator.toState(this.envelope);
  }

  /** Debounced optimistic publish; coalesces rapid draft/view changes. */
  publish(change: { composer_draft?: string; selected_view?: string }): void {
    if (this.closed || !this.envelope) return;
    if (typeof change.composer_draft === 'string') {
      this.pendingPatch.composer_draft = change.composer_draft.slice(0, MAX_DRAFT_LENGTH);
    }
    if (typeof change.selected_view === 'string') {
      this.pendingPatch.selected_view = change.selected_view.slice(0, 128);
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const patch = this.pendingPatch;
      this.pendingPatch = {};
      void this.publishNow(patch).catch(this.onError);
    }, PUBLISH_DEBOUNCE_MS);
  }

  /** Immediate surface-presence publication (shutdown handshake). */
  async publishPresence(signal?: AbortSignal): Promise<void> {
    if (this.closed || !this.envelope) return;
    await this.publishNow({}, signal).catch((error) => {
      this.onError(error);
    });
  }

  /** Serialized optimistic mutation. A 409 is re-read and rethrown, never retried blind. */
  private publishNow(change: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const operation = async (): Promise<unknown> => {
      if (!this.envelope) throw new Error('Floyd Core experience is not started');
      const base = this.envelope;
      try {
        const envelope = parseEnvelope(await this.request('PATCH', `/api/experience/${ENVELOPE_ID}`, {
          expected_revision: base.revision,
          ...change,
          surface: {
            surface_id: DESKTOP_SURFACE_ID,
            sdk_version: FLOYD_SDK_PROTOCOL_VERSION,
            capabilities: [...DESKTOP_CAPABILITIES],
            transcript_cursor: base.transcript_cursor,
            transcript_epoch: base.transcript_epoch,
            last_event_id: base.last_event_id,
          },
        }, signal));
        if (!this.envelope || envelope.revision >= this.envelope.revision) this.envelope = envelope;
        return this.envelope;
      } catch (error) {
        // Refresh local truth for recovery, but preserve the original conflict.
        const fresh = await this.request('GET', `/api/experience/${ENVELOPE_ID}`, undefined, AbortSignal.timeout(BOOT_TIMEOUT_MS))
          .then((payload) => parseEnvelope(payload))
          .catch(() => null);
        this.envelope = fresh ?? base;
        this.onEnvelope(DesktopExperienceCoordinator.toState(this.envelope));
        throw error;
      }
    };
    const queued = this.publishTail.then(operation, operation);
    this.publishTail = queued.catch(() => undefined);
    return queued;
  }

  private startWatch(): void {
    const controller = new AbortController();
    this.watchAbort = controller;
    const task = this.watch(controller).catch((error) => {
      if (!controller.signal.aborted && !this.closed) this.onError(error);
    });
    this.watchTask = task;
    void task.finally(() => {
      if (this.watchTask === task) this.watchTask = null;
    });
  }

  private async watch(controller: AbortController): Promise<void> {
    let failures = 0;
    while (!controller.signal.aborted && !this.closed) {
      try {
        if (failures > 0) {
          // A fresh GET is authoritative even when Core was restored to a
          // lower revision than this process previously observed.
          const restored = parseEnvelope(await this.request(
            'GET', `/api/experience/${ENVELOPE_ID}`, undefined, controller.signal));
          if (!this.envelope || restored.revision !== this.envelope.revision) {
            this.envelope = restored;
            this.onEnvelope(DesktopExperienceCoordinator.toState(restored));
          }
        }
        const response = await this.fetchImpl(`${this.baseUrl}/api/experience/${ENVELOPE_ID}/stream`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'text/event-stream',
            'last-event-id': String(this.envelope?.revision ?? 0),
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new FloydCoreApiError('GET', `/api/experience/${ENVELOPE_ID}/stream`, response.status, await response.text().catch(() => ''));
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            if (controller.signal.aborted || this.closed) break;
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
            const typeLine = frame.split('\n').find((line) => line.startsWith('event:'));
            const eventType = typeLine ? typeLine.slice(6).trim() : 'message';
            if (!dataLine || eventType !== 'experience') continue;
            let parsed: ExperienceEnvelope;
            try {
              parsed = parseEnvelope(JSON.parse(dataLine.slice(5).trimStart()));
            } catch {
              continue;
            }
            if (this.envelope && parsed.revision <= this.envelope.revision) continue;
            failures = 0;
            this.envelope = parsed;
            this.onEnvelope(DesktopExperienceCoordinator.toState(parsed));
          }
        }
        if (!controller.signal.aborted && !this.closed) throw new Error('Floyd Core experience stream ended');
      } catch (error) {
        if (controller.signal.aborted || this.closed) return;
        this.onError(error);
        failures += 1;
        const delay = Math.min(150 * 2 ** Math.min(failures - 1, 6), 2_000);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }

  /** Flush pending publications, stop the watch, and refuse further work. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watchAbort?.abort();
    await this.watchTask;
    const pending = this.pendingPatch;
    this.pendingPatch = {};
    if (Object.keys(pending).length > 0 && this.envelope) {
      await this.publishNow(pending).catch(this.onError);
    }
    await this.publishTail;
  }
}
