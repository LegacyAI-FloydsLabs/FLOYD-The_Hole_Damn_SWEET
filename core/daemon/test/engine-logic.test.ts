import test from "node:test";
import assert from "node:assert/strict";
import { newestMessage, isTerminalAssistant, containsAssistantTurn } from "../src/engine-logic.ts";

// Fixtures mirror the live 1.17.15 /message shape: NEWEST FIRST (verified 2026-07-12).
const userMsg = { id: "msg_1", type: "user", time: { created: 100 } };
const toolCallTurn = { id: "msg_2", type: "assistant", time: { created: 200, completed: 210 }, finish: "tool-calls" };
const finalTurn = { id: "msg_3", type: "assistant", time: { created: 300, completed: 320 }, finish: "stop" };
const erroredTurn = { id: "msg_4", type: "assistant", time: { created: 400, completed: 410 }, finish: "error", error: { message: "boom" } };

test("newestMessage picks by created time regardless of array order", () => {
  assert.equal(newestMessage([finalTurn, toolCallTurn, userMsg])?.id, "msg_3"); // newest-first input
  assert.equal(newestMessage([userMsg, toolCallTurn, finalTurn])?.id, "msg_3"); // oldest-first input
  assert.equal(newestMessage([]), null);
});

test("a tool-calls turn is NOT terminal", () => {
  assert.equal(isTerminalAssistant(toolCallTurn), false);
});

test("a completed stop turn IS terminal", () => {
  assert.equal(isTerminalAssistant(finalTurn), true);
});

test("an errored turn is terminal (caller surfaces the error)", () => {
  assert.equal(isTerminalAssistant(erroredTurn), true);
});

test("a user message is not terminal", () => {
  assert.equal(isTerminalAssistant(userMsg), false);
});

test("an incomplete assistant turn is not terminal", () => {
  assert.equal(isTerminalAssistant({ type: "assistant", time: { created: 500 } }), false);
});

test("containsAssistantTurn drives the recovery re-prompt decision", () => {
  assert.equal(containsAssistantTurn([userMsg]), false); // never ran -> re-prompt is safe
  assert.equal(containsAssistantTurn([toolCallTurn, userMsg]), true); // ran -> observe only
  assert.equal(containsAssistantTurn([]), false);
});

test("isStalledToolCalls identifies a dead mid-loop turn needing continuation", async () => {
  const { isStalledToolCalls } = await import("../src/engine-logic.ts");
  assert.equal(isStalledToolCalls([toolCallTurn, userMsg]), true);   // newest completed tool-calls -> stalled
  assert.equal(isStalledToolCalls([finalTurn, toolCallTurn]), false); // newest is stop -> not stalled
  assert.equal(isStalledToolCalls([userMsg]), false);                 // never ran -> handled by re-prompt path
  assert.equal(isStalledToolCalls([]), false);
});
