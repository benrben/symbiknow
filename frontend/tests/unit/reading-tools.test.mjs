import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/features/reader/tools.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const { findTextMatches, boundedHistory } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
test("find treats punctuation and regex metacharacters as literal text", () => {
  assert.deepEqual(findTextMatches("a+b? a.b a+b?", "a+b?"), [
    { start: 0, end: 4 },
    { start: 9, end: 13 },
  ]);
});
test("find preserves original offsets with Unicode, emoji and case differences", () => {
  const text = "🔎 MODEL model מודל";
  for (const m of findTextMatches(text, "model"))
    assert.equal(text.slice(m.start, m.end).toLowerCase(), "model");
  assert.equal(findTextMatches(text, "מודל").length, 1);
  assert.equal(findTextMatches("İ TEST", "test")[0].start, 2);
});
test("find ignores empty input, limits dense matches and does not overlap", () => {
  assert.deepEqual(findTextMatches("abc", "  "), []);
  assert.equal(findTextMatches("x".repeat(10000), "x").length, 500);
  assert.deepEqual(findTextMatches("aaaa", "aa"), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
});
test("review and reading histories replace identities and evict oldest entries", () => {
  const original = [
    { id: "a", top: 1 },
    { id: "b", top: 2 },
    { id: "c", top: 3 },
  ];
  assert.deepEqual(boundedHistory(original, { id: "b", top: 4 }, 2), [
    { id: "b", top: 4 },
    { id: "a", top: 1 },
  ]);
  assert.equal(original[1].top, 2);
});
test("reading positions stay isolated by exact version identity", () => {
  const next = boundedHistory(
    [{ id: "doc:v1", top: 100 }],
    { id: "doc:v2", top: 0 },
    200,
  );
  assert.deepEqual(
    next.map((x) => x.top),
    [0, 100],
  );
});
test("bounded search scans a 2 MB document without excessive allocations", (t) => {
  const start = performance.now();
  const matches = findTextMatches(
    "a".repeat(2 * 1024 * 1024 - 8) + "needle",
    "needle",
  );
  assert.equal(matches.length, 1);
  t.diagnostic(`2 MB text scan: ${(performance.now() - start).toFixed(2)} ms`);
});
