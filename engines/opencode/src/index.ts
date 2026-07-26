import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { SessionMessage } from "@opencode-ai/sdk/v2/types";

export interface OpenCodeRuntimeOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  reconnectDelayMs?: number;
}

export interface OpenCodeSubscription {
  stop(): void;
}

type PermissionReply = "once" | "always" | "reject";

/**
 * Typed boundary around the official OpenCode SDK.
 *
 * Only Floyd Core imports this package. User-facing clients speak to Core via
 * @floyd/sdk, preserving Core as the sole lifecycle, policy, and evidence
 * authority while OpenCode remains the supervised coding engine.
 */
export class OpenCodeSdkRuntime {
  readonly baseUrl: string;
  private readonly client: OpencodeClient;
  private readonly reconnectDelayMs: number;

  constructor(options: OpenCodeRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1500;
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      fetch: options.fetch,
      responseStyle: "fields",
      throwOnError: true,
    });
  }

  private callOptions(signal?: AbortSignal) {
    return {
      responseStyle: "fields" as const,
      throwOnError: true as const,
      ...(signal ? { signal } : {}),
    };
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    const result = await this.client.v2.health.get(this.callOptions(signal));
    return Boolean(result.data?.healthy);
  }

  async createSession(directory: string, providerID: string, modelID: string, agent?: string): Promise<string> {
    const result = await this.client.v2.session.create(
      {
        location: { directory },
        model: { providerID, id: modelID },
        ...(agent ? { agent } : {}),
      },
      this.callOptions(),
    );
    const id = result.data?.data.id;
    if (!id) throw new Error("OpenCode SDK session create returned no id");
    return id;
  }

  async prompt(sessionID: string, text: string): Promise<void> {
    await this.client.v2.session.prompt(
      { sessionID, prompt: { text }, delivery: "queue", resume: true },
      this.callOptions(),
    );
  }

  /** Mid-run guidance is admitted through OpenCode's explicit steer delivery. */
  async steer(sessionID: string, text: string): Promise<void> {
    await this.client.v2.session.prompt(
      { sessionID, prompt: { text }, delivery: "steer", resume: true },
      this.callOptions(),
    );
  }

  async switchModel(sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.client.v2.session.switchModel(
      { sessionID, model: { providerID, id: modelID } },
      this.callOptions(),
    );
  }

  /** Stop active model/tool work for a session through the official SDK. */
  async abortSession(sessionID: string): Promise<void> {
    // The 1.17.18 SDK's v2 Session3 surface omits abort even though session
    // creation/prompt live there. The official stable session surface exposes
    // the required abort endpoint and accepts the same session IDs.
    await this.client.session.abort({ sessionID }, this.callOptions());
  }

  async messages(sessionID: string): Promise<SessionMessage[]> {
    const result = await this.client.v2.session.messages(
      // OpenCode 1.17.18 rejects values above 200 with HTTP 400. A larger
      // value made Core's idle poll fail forever while the model kept running.
      { sessionID, order: "desc", limit: 200 },
      this.callOptions(),
    );
    return result.data?.data ?? [];
  }

  async pendingPermissions(sessionID: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.v2.session.permission.list({ sessionID }, this.callOptions());
    return (result.data?.data ?? []) as unknown as Array<Record<string, unknown>>;
  }

  async replyPermission(sessionID: string, requestID: string, reply: PermissionReply): Promise<void> {
    await this.client.v2.session.permission.reply(
      { sessionID, requestID, reply },
      this.callOptions(),
    );
  }

  async pendingQuestions(sessionID: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.v2.session.question.list({ sessionID }, this.callOptions());
    return (result.data?.data ?? []) as unknown as Array<Record<string, unknown>>;
  }

  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void> {
    await this.client.v2.session.question.reply(
      { sessionID, requestID, questionV2Reply: { answers } },
      this.callOptions(),
    );
  }

  /**
   * Subscribe to OpenCode's native event bus with deterministic teardown.
   *
   * The AbortController signal is passed into the generated SDK SSE reader.
   * stop() therefore cancels the active fetch, which cancels the stream reader
   * and releases its backpressure buffer. The outer loop reconnects only after
   * an unexpected clean EOF; it cannot reconnect after stop() has aborted it.
   */
  subscribeEvents(onEvent: (event: unknown) => void, onError?: (error: unknown) => void): OpenCodeSubscription {
    const controller = new AbortController();
    let stopped = false;

    const pause = (): Promise<void> => new Promise((resolve) => {
      const timeout = setTimeout(resolve, this.reconnectDelayMs);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    void (async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const result = await this.client.v2.event.subscribe({
            ...this.callOptions(controller.signal),
            sseMaxRetryAttempts: 4,
            onSseError: (error) => {
              if (!controller.signal.aborted) onError?.(error);
            },
          });
          for await (const event of result.stream) {
            if (stopped || controller.signal.aborted) break;
            onEvent(event);
          }
        } catch (error) {
          if (!controller.signal.aborted) onError?.(error);
        }
        if (!stopped && !controller.signal.aborted) await pause();
      }
    })();

    return {
      stop() {
        stopped = true;
        controller.abort(new Error("Floyd Core stopped the OpenCode event subscription"));
      },
    };
  }
}
