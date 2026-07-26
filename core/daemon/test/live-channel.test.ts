import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEngineEvent, type SessionMap } from "../src/live-channel.ts";

// Engine /event frames are `{type, properties}` objects (1.17.15). The
// normalizer attributes them to Floyd IDs via the jobs table's session map and
// drops frames for sessions Floyd doesn't own.
const map: SessionMap = new Map([
  ["ses_engine_1", { run_id: "run_A", job_id: "job_A1", kind: "builder" }],
]);

test("attributes an owned session event to floyd ids", () => {
  const evt = {
    type: "message.part.updated",
    properties: { part: { sessionID: "ses_engine_1", type: "text", text: "hi" } },
  };
  const out = normalizeEngineEvent(evt, map);
  assert.ok(out);
  assert.equal(out.run_id, "run_A");
  assert.equal(out.job_id, "job_A1");
  assert.equal(out.kind, "builder");
  assert.equal(out.engine_session_id, "ses_engine_1");
  assert.equal(out.type, "message.part.updated");
});

test("finds sessionID at any common nesting", () => {
  for (const evt of [
    { type: "session.updated", properties: { info: { id: "ses_engine_1" } } },
    { type: "permission.v2.asked", properties: { sessionID: "ses_engine_1", id: "per_x" } },
    { type: "message.updated", properties: { info: { sessionID: "ses_engine_1" } } },
  ]) {
    const out = normalizeEngineEvent(evt, map);
    assert.ok(out, `should attribute ${evt.type}`);
    assert.equal(out.run_id, "run_A");
  }
});

test("drops events for sessions floyd does not own", () => {
  const out = normalizeEngineEvent(
    { type: "message.updated", properties: { info: { sessionID: "ses_foreign" } } },
    map,
  );
  assert.equal(out, null);
});

test("drops heartbeats and unattributable frames", () => {
  assert.equal(normalizeEngineEvent({ type: "server.heartbeat" }, map), null);
  assert.equal(normalizeEngineEvent({ type: "server.connected", properties: {} }, map), null);
});

test("flags permission asks so surfaces can render them prominently", () => {
  const out = normalizeEngineEvent(
    { type: "permission.v2.asked", properties: { sessionID: "ses_engine_1", id: "per_1", action: "external_directory" } },
    map,
  );
  assert.ok(out);
  assert.equal(out.is_permission_ask, true);
});

test("attributes real 1.17.15 /api/event frames (data.sessionID + durable.aggregateID)", () => {
  const frames = [
    { type: "session.next.tool.called", durable: { aggregateID: "ses_engine_1", seq: 5 }, data: { sessionID: "ses_engine_1", tool: "write" } },
    { type: "session.next.step.started", durable: { aggregateID: "ses_engine_1" }, data: {} },
    { type: "session.next.prompt.admitted", data: { sessionID: "ses_engine_1", prompt: { text: "x" } } },
  ];
  for (const f of frames) {
    const out = normalizeEngineEvent(f, map);
    assert.ok(out, `should attribute ${f.type}`);
    assert.equal(out.run_id, "run_A");
    assert.equal(out.engine_session_id, "ses_engine_1");
  }
});

test("real-shape foreign frames are dropped", () => {
  const out = normalizeEngineEvent(
    { type: "session.next.tool.called", durable: { aggregateID: "ses_other" }, data: { sessionID: "ses_other" } },
    map,
  );
  assert.equal(out, null);
});
