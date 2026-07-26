import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachArguments } from "../src/attach-args.ts";

test("attach arguments preserve explicit run scope", () => {
  assert.deepEqual(parseAttachArguments(["session-1"]), { sessionId: "session-1" });
  assert.deepEqual(parseAttachArguments(["session-1", "42"]), { sessionId: "session-1", lastEventId: "42" });
  assert.deepEqual(parseAttachArguments(["session-1", "42", "--run", "run-1"]), {
    sessionId: "session-1",
    lastEventId: "42",
    runId: "run-1",
  });
  assert.deepEqual(parseAttachArguments(["session-1", "--run", "run-1"]), { sessionId: "session-1", runId: "run-1" });
});

test("attach arguments reject ambiguous or incomplete scope", () => {
  assert.throws(() => parseAttachArguments([]), /usage/);
  assert.throws(() => parseAttachArguments(["session-1", "1", "2"]), /usage/);
  assert.throws(() => parseAttachArguments(["session-1", "--run"]), /usage/);
  assert.throws(() => parseAttachArguments(["session-1", "--other", "run-1"]), /usage/);
});
