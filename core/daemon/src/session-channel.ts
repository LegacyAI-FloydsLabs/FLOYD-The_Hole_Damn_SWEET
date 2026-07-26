/**
 * Bidirectional session channel — pure logic (unit-tested).
 * Taxonomy: engine frames -> the five contract event types
 *   token | tool_call_start | tool_call_finish | question | permission
 * SessionBuffer: per-session monotonic seq + bounded replay for Last-Event-ID.
 */

export interface Classified {
  type: "token" | "tool_call_start" | "tool_call_finish" | "question" | "permission";
  channel?: "text" | "reasoning";
}

export function classifyEngineEvent(frameType: string, _data: unknown): Classified | null {
  if (frameType.endsWith(".text.delta")) return { type: "token", channel: "text" };
  if (frameType.endsWith(".reasoning.delta")) return { type: "token", channel: "reasoning" };
  if (frameType.endsWith(".tool.called")) return { type: "tool_call_start" };
  if (frameType.endsWith(".tool.success") || frameType.endsWith(".tool.error")) return { type: "tool_call_finish" };
  if (frameType.includes("question") && frameType.includes("asked")) return { type: "question" };
  if (frameType.includes("permission") && frameType.includes("asked")) return { type: "permission" };
  return null;
}

export interface BufferedEvent {
  seq: number;
  event: unknown;
}

export class SessionBuffer {
  private sessions = new Map<string, { seq: number; events: BufferedEvent[] }>();
  private capacity: number;

  constructor(capacity = 5000) {
    this.capacity = capacity;
  }

  append(sessionId: string, event: unknown): number {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { seq: 0, events: [] };
      this.sessions.set(sessionId, s);
    }
    s.seq += 1;
    s.events.push({ seq: s.seq, event });
    if (s.events.length > this.capacity) s.events.splice(0, s.events.length - this.capacity);
    return s.seq;
  }

  /** All buffered events with seq strictly greater than afterSeq, in order. */
  since(sessionId: string, afterSeq: number): BufferedEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.events.filter((e) => e.seq > afterSeq);
  }

  lastSeq(sessionId: string): number {
    return this.sessions.get(sessionId)?.seq ?? 0;
  }
}
