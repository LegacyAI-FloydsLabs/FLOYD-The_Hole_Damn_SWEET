/**
 * Live session channel: normalizes engine /event SSE frames into Floyd-attributed
 * events for surfaces. Pure logic here (unit-tested); transport lives in http.ts.
 */

export interface SessionAttribution {
  run_id: string;
  job_id: string;
  kind: string; // builder | reviewer
}

export type SessionMap = Map<string, SessionAttribution>;

export interface FloydLiveEvent {
  type: string;
  run_id: string;
  job_id: string;
  kind: string;
  engine_session_id: string;
  is_permission_ask: boolean;
  properties: unknown;
}

/**
 * Locate a sessionID across observed 1.17.15 frame shapes:
 * - /api/event durable frames: data.sessionID, durable.aggregateID
 * - legacy/properties frames: properties.sessionID and common nestings
 */
function extractSessionId(evt: Record<string, unknown>): string | null {
  const props = (evt.properties ?? {}) as Record<string, unknown>;
  const data = (evt.data ?? {}) as Record<string, unknown>;
  const durable = (evt.durable ?? {}) as Record<string, unknown>;
  const candidates = [
    data.sessionID,
    durable.aggregateID,
    props.sessionID,
    (props.info as Record<string, unknown> | undefined)?.sessionID,
    (props.info as Record<string, unknown> | undefined)?.id,
    (props.part as Record<string, unknown> | undefined)?.sessionID,
    (props.message as Record<string, unknown> | undefined)?.sessionID,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("ses_")) return c;
  }
  return null;
}

/**
 * Attribute an engine event to Floyd IDs. Returns null for frames Floyd does
 * not own (foreign sessions, heartbeats, unattributable frames) — those never
 * reach a surface.
 */
export function normalizeEngineEvent(evt: unknown, map: SessionMap): FloydLiveEvent | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;
  const type = String(e.type ?? "");
  if (!type || type.startsWith("server.")) return null;
  const sessionId = extractSessionId(e);
  if (!sessionId) return null;
  const attribution = map.get(sessionId);
  if (!attribution) return null;
  return {
    type,
    run_id: attribution.run_id,
    job_id: attribution.job_id,
    kind: attribution.kind,
    engine_session_id: sessionId,
    is_permission_ask: type.includes("permission") && type.includes("asked"),
    properties: e.data ?? e.properties ?? null,
  };
}
