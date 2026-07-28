import {
  pipeRedactedBody,
  redactSecretText,
} from "./exact-secret-redactor.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
]);
const MCP_METHODS = new Set(["GET", "POST", "DELETE"]);

/**
 * Vault-owned remote MCP routing.
 *
 * `resolveTarget` belongs to the OS-protected Vault authority (Keychain on
 * macOS). This router never reads a file containing a remote destination or a
 * real authorization header. The caller must invoke this handler only after
 * validating the application's fv_ capability.
 */
export function createVaultMcpRouter({
  resolveTarget,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof resolveTarget !== "function") throw new Error("Vault MCP target resolver is required");

  return {
    async handle({ req, res, requestUrl, body, app, signal, recordRoute = () => {} }) {
      const match = requestUrl.pathname.match(/^\/mcp\/([A-Za-z0-9._-]{1,100})$/);
      if (!match) return false;
      if (!MCP_METHODS.has(req.method)) {
        writeJson(res, 405, { error: { message: "Vault MCP transport supports GET, POST, and DELETE." } }, {
          allow: "GET, POST, DELETE",
        });
        return true;
      }

      const targetId = match[1];
      let target;
      try {
        target = validateTarget(await resolveTarget({ id: targetId, app }));
      } catch (error) {
        writeJson(res, error.status || 503, { error: { message: error.publicMessage || "Vault MCP target is unavailable." } });
        return true;
      }

      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (REQUEST_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      Object.assign(headers, target.headers);
      const targetSecrets = Object.values(target.headers);

      try {
        const hasBody = req.method === "POST" && body?.length;
        const upstream = await fetchImpl(target.url, {
          method: req.method,
          headers,
          body: hasBody ? body : undefined,
          duplex: hasBody ? "half" : undefined,
          redirect: "manual",
          signal,
        });
        recordRoute(`mcp:${targetId}`, upstream.status);
        const responseHeaders = {};
        for (const [name, value] of upstream.headers) {
          if (RESPONSE_HEADERS.has(name.toLowerCase())) {
            responseHeaders[name] = redactSecretText(value, targetSecrets);
          }
        }
        res.writeHead(upstream.status, responseHeaders);
        await pipeRedactedBody(upstream.body, res, targetSecrets);
        res.end();
      } catch {
        writeJson(res, 502, { error: { message: "Vault MCP upstream request failed." } });
      }
      return true;
    },
  };
}

function validateTarget(raw) {
  if (!raw) throw publicError(404, "Vault MCP target is not configured.");
  if (!raw || typeof raw !== "object") throw publicError(503, "Vault MCP target is invalid.");
  if (typeof raw.url !== "string") throw publicError(503, "Vault MCP target is invalid.");
  const url = new URL(raw.url);
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !loopback) throw publicError(503, "Vault MCP target is invalid.");
  if (url.username || url.password || url.hash) throw publicError(503, "Vault MCP target is invalid.");

  const headers = {};
  for (const [name, value] of Object.entries(raw.headers || {})) {
    const normalized = name.toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || ["host", "connection", "content-length", "transfer-encoding"].includes(normalized)
      || typeof value !== "string") {
      throw publicError(503, "Vault MCP target headers are invalid.");
    }
    headers[name] = value;
  }
  return { url: url.toString(), headers };
}

function publicError(status, publicMessage) {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}

function writeJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}
