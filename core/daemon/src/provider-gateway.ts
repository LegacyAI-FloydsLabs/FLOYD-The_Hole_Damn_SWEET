import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ServerResponse } from "node:http";

export type ProviderRoute = "opencode-zen" | "opencode-go" | "openai" | "anthropic" | "auto";
export type ProviderDialect = "openai" | "anthropic";
export type RelayCredential = {
  provider: Exclude<ProviderRoute, "auto">;
  baseUrl: string;
  authorization?: string;
  apiKey?: string;
};

const DEFAULT_BASE_URLS: Record<Exclude<ProviderRoute, "auto">, string> = {
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const RESPONSE_HEADER_TIMEOUT_MS = 30_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

type ChatMessage = { role: string; content: unknown };
type ChatPayload = Record<string, unknown> & { model?: unknown; messages?: unknown; stream?: unknown };

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Resolve one configured base URL without permitting credentials in the URL. */
export function resolveProviderEndpoint(route: ProviderRoute, override: string | undefined, model: string): {
  endpoint: URL;
  dialect: ProviderDialect;
} {
  const inferredAnthropic = route === "anthropic" || model.toLowerCase().startsWith("claude-") || /anthropic/i.test(override ?? "");
  const dialect: ProviderDialect = inferredAnthropic ? "anthropic" : "openai";
  const fallbackRoute = route === "auto" ? (dialect === "anthropic" ? "anthropic" : "openai") : route;
  const endpoint = new URL(override ?? DEFAULT_BASE_URLS[fallbackRoute]);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("provider base URL must not contain credentials, query parameters, or a fragment");
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))) {
    throw new Error("provider base URL must use HTTPS; HTTP is allowed only for loopback development endpoints");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = endpoint.pathname.replace(/\/(chat\/completions|messages)$/, "");
  endpoint.pathname += dialect === "anthropic" ? "/messages" : "/chat/completions";
  return { endpoint, dialect };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
    return "";
  }).join("\n");
}

/** Translate the shared OpenAI-style conversation contract to a vendor payload. */
export function translatePayload(payload: ChatPayload, dialect: ProviderDialect): ChatPayload {
  if (!Array.isArray(payload.messages)) throw new Error("messages must be an array");
  if (typeof payload.model !== "string" || payload.model.length === 0) throw new Error("model is required");
  if (dialect === "openai") return { ...payload, stream: payload.stream !== false };

  const messages = payload.messages as ChatMessage[];
  const system = messages
    .filter((message) => message?.role === "system")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const translated = messages
    .filter((message) => message?.role !== "system")
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
  const { messages: _messages, ...rest } = payload;
  return { ...rest, messages: translated, ...(system ? { system } : {}), stream: payload.stream !== false };
}

export function normalizeProviderFrame(dialect: ProviderDialect, frame: unknown): { text?: string; finish_reason?: string } | null {
  if (!frame || typeof frame !== "object") return null;
  const data = frame as Record<string, any>;
  if (dialect === "openai") {
    const choice = data.choices?.[0];
    const content = choice?.delta?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? contentToText(content) : undefined;
    const finish = choice?.finish_reason;
    return text !== undefined || finish
      ? { ...(text !== undefined ? { text } : {}), ...(finish ? { finish_reason: String(finish) } : {}) }
      : null;
  }
  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") return { text: String(data.delta.text ?? "") };
  if (data.type === "message_delta" && data.delta?.stop_reason) return { finish_reason: String(data.delta.stop_reason) };
  if (data.type === "message_stop") return { finish_reason: "stop" };
  return null;
}

function writeSse(res: ServerResponse, event: "delta" | "done" | "error", data: unknown): boolean {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Reverse-proxy one provider call and normalize its stream.
 *
 * The outbound ClientRequest is retained so an incoming abort/close can call
 * destroy() immediately. That tears down the provider socket and its readable
 * stream instead of leaving a paid model response draining in the background.
 */
export async function relayProviderRequest(req: IncomingMessage, res: ServerResponse, credential?: RelayCredential): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("gateway request exceeds 4 MiB"), { statusCode: 413 });
    chunks.push(buffer);
  }
  let payload: ChatPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatPayload;
  } catch (error) {
    throw Object.assign(new Error(`invalid gateway JSON: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 400 });
  }
  const route = credential?.provider ?? (header(req, "x-floyd-provider") ?? "auto") as ProviderRoute;
  if (!["opencode-zen", "opencode-go", "openai", "anthropic", "auto"].includes(route)) {
    throw Object.assign(new Error(`unsupported provider route: ${route}`), { statusCode: 400 });
  }
  let resolved: ReturnType<typeof resolveProviderEndpoint>;
  let translated: ChatPayload;
  try {
    const requestedBaseUrl = header(req, "x-floyd-base-url");
    if (credential && requestedBaseUrl && requestedBaseUrl.replace(/\/+$/, "") !== credential.baseUrl.replace(/\/+$/, "")) {
      throw new Error("connector credential is bound to a different provider endpoint");
    }
    resolved = resolveProviderEndpoint(route, credential?.baseUrl ?? requestedBaseUrl, String(payload.model ?? ""));
    translated = translatePayload(payload, resolved.dialect);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { statusCode: 400 });
  }
  const { endpoint, dialect } = resolved;
  const body = Buffer.from(JSON.stringify(translated));
  const authorization = credential?.authorization ?? header(req, "authorization");
  const apiKey = credential?.apiKey ?? header(req, "x-api-key");
  if (dialect === "anthropic" && !apiKey && !authorization) throw Object.assign(new Error("x-api-key or Authorization is required for Anthropic routes"), { statusCode: 400 });
  if (dialect === "openai" && !authorization) throw Object.assign(new Error("Authorization: Bearer is required for OpenAI-compatible routes"), { statusCode: 400 });

  const headers: Record<string, string | number> = {
    "content-type": "application/json",
    accept: translated.stream === false ? "application/json" : "text/event-stream",
    "content-length": body.length,
  };
  if (authorization) headers.authorization = authorization;
  if (apiKey) headers["x-api-key"] = apiKey;
  if (dialect === "anthropic") headers["anthropic-version"] = header(req, "anthropic-version") ?? "2023-06-01";

  await new Promise<void>((resolve, reject) => {
    let upstreamResponse: IncomingMessage | undefined;
    let finished = false;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const options: RequestOptions = { method: "POST", headers };
    const transport = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamRequest = transport(endpoint, options, (upstream) => {
      if (headerTimer) clearTimeout(headerTimer);
      upstreamResponse = upstream;
      const status = upstream.statusCode ?? 502;
      const contentType = String(upstream.headers["content-type"] ?? "application/json");
      if (status < 200 || status >= 300) {
        res.writeHead(status, {
          "content-type": contentType,
          ...(upstream.headers["retry-after"] ? { "retry-after": String(upstream.headers["retry-after"]) } : {}),
          ...(upstream.headers["request-id"] ? { "request-id": String(upstream.headers["request-id"]) } : {}),
        });
        upstream.on("data", (chunk) => { if (!res.write(chunk)) upstream.pause(); });
        res.on("drain", () => upstream.resume());
        upstream.on("end", () => { finished = true; res.end(); resolve(); });
        upstream.on("error", reject);
        return;
      }
      if (translated.stream === false) {
        res.writeHead(status, { "content-type": contentType });
        upstream.on("data", (chunk) => { if (!res.write(chunk)) upstream.pause(); });
        res.on("drain", () => upstream.resume());
        upstream.on("end", () => { finished = true; res.end(); resolve(); });
        upstream.on("error", reject);
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let buffer = "";
      let sentDone = false;
      let sentError = false;
      const consume = (rawFrame: string) => {
        if (finished) return;
        const upstreamEvent = rawFrame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = rawFrame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) return;
        if (data === "[DONE]") {
          if (!sentDone) writeSse(res, "done", { finish_reason: "stop" });
          sentDone = true;
          return;
        }
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* exact text remains reportable */ }
        const providerError = upstreamEvent === "error"
          || (parsed !== null && typeof parsed === "object" && (
            "error" in parsed || (parsed as { type?: unknown }).type === "error"
          ));
        if (providerError) {
          if (!sentError) writeSse(res, "error", parsed);
          sentError = true;
          finished = true;
          upstream.destroy();
          res.end();
          resolve();
          return;
        }
        const normalized = normalizeProviderFrame(dialect, parsed);
        if (!normalized) return;
        if (normalized.text !== undefined && !writeSse(res, "delta", { text: normalized.text })) upstream.pause();
        if (normalized.finish_reason && !sentDone) {
          if (!writeSse(res, "done", { finish_reason: normalized.finish_reason })) upstream.pause();
          sentDone = true;
        }
      };
      res.on("drain", () => upstream.resume());
      upstream.setEncoding("utf8");
      upstream.on("data", (chunk: string) => {
        if (finished) return;
        buffer += chunk.replace(/\r\n?/g, "\n");
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
          sentError = true;
          writeSse(res, "error", { error: { type: "relay_frame_too_large", message: "provider SSE frame exceeds 1 MiB" } });
          finished = true;
          upstream.destroy();
          res.end();
          resolve();
          return;
        }
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          consume(frame);
          if (finished) break;
        }
      });
      upstream.on("end", () => {
        if (finished) return;
        if (buffer.trim()) consume(buffer);
        // A clean TCP EOF is not a model-completion signal. Proxies and
        // providers can truncate an SSE body while still closing the socket
        // cleanly, so only an explicit provider terminal frame may become
        // `done`. Anything else is a normalized terminal error.
        if (!sentDone && !sentError) {
          sentError = true;
          writeSse(res, "error", {
            error: {
              type: "upstream_stream_incomplete",
              message: "provider stream ended before an explicit terminal event",
            },
          });
        }
        finished = true;
        res.end();
        resolve();
      });
      upstream.on("error", (error) => {
        if (finished) return;
        sentError = true;
        writeSse(res, "error", { error: { type: "upstream_stream_error", message: error.message } });
        finished = true;
        res.end();
        resolve();
      });
    });

    headerTimer = setTimeout(() => {
      upstreamRequest.destroy(Object.assign(new Error("provider response header timeout"), { statusCode: 504 }));
    }, RESPONSE_HEADER_TIMEOUT_MS);
    headerTimer.unref();
    upstreamRequest.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      upstreamRequest.destroy(Object.assign(new Error("provider stream idle timeout"), { statusCode: 504 }));
    });

    const abortUpstream = () => {
      if (finished) return;
      const error = new Error("gateway client disconnected");
      upstreamResponse?.destroy(error);
      upstreamRequest.destroy(error);
    };
    req.once("aborted", abortUpstream);
    res.once("close", abortUpstream);
    upstreamRequest.once("error", (error) => {
      if (headerTimer) clearTimeout(headerTimer);
      if ((req.aborted || res.destroyed) && !finished) return resolve();
      if (upstreamResponse && res.headersSent && !finished) {
        writeSse(res, "error", { error: { type: "upstream_stream_error", message: error.message } });
        finished = true;
        res.end();
        return resolve();
      }
      reject(error);
    });
    upstreamRequest.end(body);
  });
}
