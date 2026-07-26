import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineEvent, SessionBuffer } from "../src/session-channel.ts";

// ---- taxonomy: engine frame type -> {token|tool_call_start|tool_call_finish|question|permission} ----

test("classifies text and reasoning deltas as token", () => {
  assert.deepEqual(classifyEngineEvent("session.next.text.delta", { text: "hi" }), {
    type: "token",
    channel: "text",
  });
  assert.deepEqual(classifyEngineEvent("session.next.reasoning.delta", {}), {
    type: "token",
    channel: "reasoning",
  });
});

test("classifies tool lifecycle", () => {
  assert.equal(classifyEngineEvent("session.next.tool.called", {})?.type, "tool_call_start");
  assert.equal(classifyEngineEvent("session.next.tool.success", {})?.type, "tool_call_finish");
  assert.equal(classifyEngineEvent("session.next.tool.error", {})?.type, "tool_call_finish");
});

test("classifies questions and permissions", () => {
  assert.equal(classifyEngineEvent("session.next.question.asked", {})?.type, "question");
  assert.equal(classifyEngineEvent("question.asked", {})?.type, "question");
  assert.equal(classifyEngineEvent("permission.v2.asked", {})?.type, "permission");
  assert.equal(classifyEngineEvent("session.next.permission.asked", {})?.type, "permission");
});

test("drops non-taxonomy frames", () => {
  assert.equal(classifyEngineEvent("session.next.step.started", {}), null);
  assert.equal(classifyEngineEvent("session.next.prompt.admitted", {}), null);
  assert.equal(classifyEngineEvent("server.heartbeat", {}), null);
});

// ---- per-session buffer: monotonic seq + Last-Event-ID replay ----

test("assigns monotonic seq per session and replays after a given seq", () => {
  const buf = new SessionBuffer(100);
  const s1 = buf.append("ses_A", { type: "token", data: 1 });
  const s2 = buf.append("ses_A", { type: "token", data: 2 });
  const s3 = buf.append("ses_A", { type: "tool_call_start", data: 3 });
  assert.deepEqual([s1, s2, s3], [1, 2, 3]);
  // independent session sequence
  assert.equal(buf.append("ses_B", { type: "token", data: 9 }), 1);
  // replay strictly after seq 1
  const replay = buf.since("ses_A", 1);
  assert.deepEqual(replay.map((e) => e.seq), [2, 3]);
  assert.deepEqual(replay.map((e) => (e.event as { data: number }).data), [2, 3]);
  // replay from 0 returns everything, in order
  assert.deepEqual(buf.since("ses_A", 0).map((e) => e.seq), [1, 2, 3]);
  // unknown session -> empty
  assert.deepEqual(buf.since("ses_missing", 0), []);
});

test("ring buffer drops oldest beyond capacity but seq keeps increasing", () => {
  const buf = new SessionBuffer(3);
  for (let i = 1; i <= 5; i++) buf.append("ses_A", { i });
  const all = buf.since("ses_A", 0);
  assert.deepEqual(all.map((e) => e.seq), [3, 4, 5]); // oldest 1,2 evicted
  assert.equal(buf.lastSeq("ses_A"), 5);
});
