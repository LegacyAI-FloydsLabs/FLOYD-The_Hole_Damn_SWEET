const ID = /^[A-Za-z0-9._-]{1,100}$/;
const APP = /^[A-Za-z0-9._-]{1,64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Validated management and runtime resolution for Keychain-backed MCP targets.
 *
 * `readTargets`/`writeTargets` must read and write the dedicated Keychain
 * account. Public methods never return URLs or header values.
 */
export function createVaultMcpManagement({ readTargets, writeTargets }) {
  if (typeof readTargets !== "function" || typeof writeTargets !== "function") {
    throw new Error("Vault MCP management requires Keychain read/write functions");
  }

  const load = async () => {
    const document = await readTargets();
    if (document === null || document === undefined) return { version: 1, targets: {} };
    if (document?.version !== 1 || !document.targets || typeof document.targets !== "object") {
      throw new Error("Vault MCP target account is invalid");
    }
    return structuredClone(document);
  };

  return {
    async list() {
      const document = await load();
      return Object.entries(document.targets).map(([id, target]) => redact(id, target));
    },

    async upsert(id, input) {
      const target = validateTarget(id, input);
      const document = await load();
      document.targets[id] = target;
      await writeTargets(document);
      return redact(id, target);
    },

    async remove(id) {
      assertId(id);
      const document = await load();
      if (!document.targets[id]) return false;
      delete document.targets[id];
      await writeTargets(document);
      return true;
    },

    async resolveTarget({ id, app }) {
      assertId(id);
      if (!APP.test(String(app || ""))) throw publicError(403, "Application is not authorized for this MCP target.");
      const document = await load();
      const target = document.targets[id];
      if (!target) return null;
      if (!target.apps.includes(app)) throw publicError(403, "Application is not authorized for this MCP target.");
      return { url: target.url, headers: { ...target.headers } };
    },
  };
}

function validateTarget(id, input) {
  assertId(id);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP target body is required");
  const url = new URL(String(input.url || ""));
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !loopback) throw new Error("MCP target must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.hash) throw new Error("MCP target URL cannot contain userinfo or a fragment");

  const headers = {};
  for (const [name, value] of Object.entries(input.headers || {})) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || ["host", "connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())
      || typeof value !== "string") {
      throw new Error("MCP target contains an invalid header");
    }
    headers[name] = value;
  }
  const apps = [...new Set((Array.isArray(input.apps) ? input.apps : ["cursem"]).map(String))];
  if (apps.length === 0 || apps.some((app) => !APP.test(app))) throw new Error("MCP target apps are invalid");
  return { url: url.toString(), headers, apps };
}

function redact(id, target) {
  return {
    id,
    configured: true,
    apps: [...target.apps],
    headerNames: Object.keys(target.headers || {}).sort(),
  };
}

function assertId(id) {
  if (!ID.test(String(id || ""))) throw new Error("MCP target id is invalid");
}

function publicError(status, publicMessage) {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}
