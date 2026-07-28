const REFRESH_SENTINEL = "__remote_refresh__";
const CREDENTIAL_ROUTE = /^\/omf-broker\/v1\/credential\/(\d+)\/(refresh|disable)$/;

/**
 * OMF's native auth-broker protocol backed by Floyd Vault.
 *
 * Every snapshot credential is the OMF application's fv_ capability. Real
 * provider credentials submitted by an explicit login flow are handed to the
 * injected OS-protected Vault writer and are never returned to OMF.
 */
export function createVaultOmpBroker({
  providers,
  setProviderEnabled = async () => {},
  getProviderState = async () => Object.fromEntries(
    providers.map((provider) => [String(provider), { configured: true, enabled: true }]),
  ),
  managementUrl = "http://127.0.0.1:13030/#vault",
}) {
  const providerIds = [...new Set(providers.map(String))];
  const byId = new Map(providerIds.map((provider, index) => [index + 1, provider]));

  return {
    isHealth(path, method) {
      return method === "GET" && path === "/omf-broker/v1/healthz";
    },

    health(res) {
      writeJson(res, 200, { ok: true, version: "floyd-vault-omf-1" });
    },

    async handle({ req, res, requestUrl, body, app, token }) {
      const path = requestUrl.pathname;
      if (!path.startsWith("/omf-broker/")) return false;
      if (app !== "omf") {
        writeJson(res, 403, { error: "OMF broker capability required" });
        return true;
      }
      const now = Date.now();
      const snapshot = async () => {
        const state = await getProviderState();
        return {
        generation: now,
        generatedAt: now,
        serverNowMs: now,
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 300_000, nextSweepInMs: 60_000 },
        credentials: providerIds
          .map((provider, index) => ({ provider, id: index + 1, state: state?.[provider] }))
          .filter(({ state: providerState }) => providerState?.configured === true && providerState?.enabled !== false)
          .map(({ provider, id }) => snapshotEntry(id, provider, token)),
        };
      };

      if (req.method === "GET" && path === "/omf-broker/v1/snapshot") {
        return writeJson(res, 200, await snapshot(), { etag: `"${now}"` }), true;
      }
      if (req.method === "GET" && path === "/omf-broker/v1/snapshot/stream") {
        return writeJson(res, 404, { error: "stream unsupported; use snapshot polling" }), true;
      }
      if (req.method === "GET" && path === "/omf-broker/v1/usage") {
        return writeJson(res, 200, { generatedAt: now, reports: [] }), true;
      }
      if (req.method === "POST" && path === "/omf-broker/v1/credential") {
        // Real credentials are never accepted from an OMF process. Login and
        // import commands hand off before prompting; this guard closes the
        // equivalent interactive /login write path.
        return writeJson(res, 409, {
          error: "Provider credentials must be entered in Floyd Vault.",
          managementUrl,
        }), true;
      }
      const match = path.match(CREDENTIAL_ROUTE);
      if (req.method === "POST" && match) {
        const id = Number(match[1]);
        const action = match[2];
        const provider = byId.get(id);
        if (!provider) return writeJson(res, 404, { error: "credential not found" }), true;
        if (action === "disable") {
          await setProviderEnabled(provider, false);
          return writeJson(res, 200, { ok: true }), true;
        }
        const state = await getProviderState();
        if (state?.[provider]?.configured !== true) {
          return writeJson(res, 404, { error: "provider is not configured in Floyd Vault", managementUrl }), true;
        }
        await setProviderEnabled(provider, true);
        return writeJson(res, 200, { entry: snapshotEntry(id, provider, token, false) }), true;
      }
      return writeJson(res, 404, { error: "OMF broker route not found" }), true;
    },
  };
}

function snapshotEntry(id, provider, token, withRotation = true) {
  return {
    id,
    provider,
    credential: { type: "api_key", key: token },
    identityKey: null,
    ...(withRotation ? { rotatesInMs: null } : {}),
  };
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
