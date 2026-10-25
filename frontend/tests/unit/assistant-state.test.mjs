import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/features/assistant/core/state.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const { emptyChat, reduceEvent, batchEvents } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const event = (type, seq, extra = {}) => ({
  type,
  seq,
  session_id: "s",
  run_id: "r",
  ...extra,
});
test("replayed events cannot duplicate tools or text and foreign sessions are ignored", () => {
  let state = reduceEvent(
    emptyChat,
    event("run_started", 1, { message: "Hello" }),
  );
  const delta = event("text_delta", 2, { text: "Answer" });
  state = reduceEvent(reduceEvent(state, delta), delta);
  state = reduceEvent(
    state,
    event("tool_call_started", 3, { id: "t", name: "unknown_tool" }),
  );
  state = reduceEvent(
    state,
    event("tool_call_args", 4, { id: "t", args: { document_id: "id" } }),
  );
  state = reduceEvent(
    state,
    event("tool_call_error", 5, { id: "t", message: "Changed" }),
  );
  assert.equal(state.runs[0].text, "Answer");
  assert.equal(state.runs[0].tools.length, 1);
  assert.equal(state.runs[0].tools[0].state, "error");
  assert.equal(
    reduceEvent(
      state,
      event("text_delta", 6, { session_id: "foreign", text: "Bad" }),
    ),
    state,
  );
});
test("late approval results update the original run and preserve denial", () => {
  const events = [
    event("run_started", 1),
    event("tool_call_started", 2, { id: "t", name: "delete" }),
    event("tool_call_awaiting_approval", 3, {
      id: "t",
      preview: { files: ["a"] },
    }),
    event("run_finished", 4),
    event("run_started", 5, { run_id: "r2" }),
    event("tool_call_denied", 6, { id: "t" }),
  ];
  const state = events.reduce(reduceEvent, emptyChat);
  assert.equal(state.runs[0].tools[0].state, "denied");
  assert.equal(state.runs[1].tools.length, 0);
  assert.match(reduceEvent(state, event("text_delta", 8)).error, /gap/);
});
test("stream rendering batches once per frame and discards callbacks on close", () => {
  let callback,
    schedules = 0,
    cancellations = 0;
  const delivered = [];
  const batch = batchEvents(
    (items) => delivered.push(items),
    (work) => {
      callback = work;
      return ++schedules;
    },
    () => cancellations++,
  );
  for (let i = 0; i < 100; i++) batch.push(i);
  assert.equal(schedules, 1);
  assert.equal(delivered.length, 0);
  callback();
  assert.equal(delivered[0].length, 100);
  batch.push(101);
  batch.dispose();
  assert.equal(cancellations, 1);
});

test("text and tool groups preserve chronology, replay, model identity and timing", () => {
  const events = [
    event("run_started", 1, {
      message: "Approval is a topic, not a receipt",
      timestamp: 1000,
    }),
    event("text_delta", 2, { text: "First." }),
    event("tool_call_started", 3, {
      id: "search",
      name: "search",
      timestamp: 2000,
    }),
    event("tool_call_started", 4, {
      id: "open",
      name: "open_document",
      timestamp: 2100,
    }),
    event("text_delta", 5, { text: "Then." }),
    event("tool_call_result", 6, { id: "search", timestamp: 3000, result: {} }),
    event("run_metadata", 7, { model: "actual-native-model" }),
    event("run_finished", 8, { timestamp: 4500 }),
  ];
  const state = events.reduce(reduceEvent, emptyChat),
    run = state.runs[0];
  assert.deepEqual(
    run.parts.map((p) => p.type),
    ["text", "tools", "text"],
  );
  assert.deepEqual(run.parts[1].ids, ["search", "open"]);
  assert.equal(run.text, "First.Then.");
  assert.equal(run.model, "actual-native-model");
  assert.equal(run.finishedAt - run.startedAt, 3500);
  assert.equal(run.tools[0].finishedAt - run.tools[0].startedAt, 1000);
  assert.equal(run.automatic, false);
  assert.equal(events.reduce(reduceEvent, state), state);
  const followup = reduceEvent(
    state,
    event("run_started", 9, { run_id: "r2", automatic: true }),
  );
  assert.equal(followup.runs[1].automatic, true);
});
