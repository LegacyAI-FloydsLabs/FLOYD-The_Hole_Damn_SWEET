import { timingSafeEqual } from "node:crypto";

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackHost(host) {
  const name = String(host || "").split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * Vault mutations require both a loopback same-origin browser context and the
 * frame's private management capability. This blocks cross-site requests and
 * unrelated local processes that do not possess the owner-only token.
 */
export function authorizeVaultManagement(headers, expectedToken) {
  const host = String(headers.host || "");
  if (!isLoopbackHost(host)) return false;
  const origin = headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (!isLoopbackHost(parsed.hostname) || parsed.host !== host) return false;
  }
  const cookie = String(headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("floyd_management="))
    ?.slice("floyd_management=".length);
  const presented = String(headers.authorization || "").replace(/^Bearer\s+/i, "") || cookie || "";
  return Boolean(expectedToken) && equal(presented, expectedToken);
}

/** Bootstrap is accepted only from the native shell's owner-only capability. */
export function authorizeManagementBootstrap(headers, expectedToken) {
  const host = String(headers.host || "");
  if (!isLoopbackHost(host) || headers.origin) return false;
  return Boolean(expectedToken) && equal(headers["x-floyd-management-bootstrap"], expectedToken);
}
