import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/searchPresentation.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
});
const { emptySearchMessage, reconcileSearchMatches, sortSearchMatches } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);

test("date sorting uses instants and keeps unknown dates last in either direction", () => {
  const docs = [
    { document_id: "unknown", filename: "A", created_at: "" },
    { document_id: "later", filename: "B", created_at: "2026-10-18T08:00:00Z" },
    { document_id: "earlier", filename: "C", created_at: "2026-10-18T09:00:00+02:00" },
    { document_id: "invalid", filename: "D", created_at: "not a date" },
  ];
  const ids = (rows) => rows.map((d) => d.document_id);
  assert.deepEqual(ids(sortSearchMatches(docs, "date", false)), ["earlier", "later", "unknown", "invalid"]);
  assert.deepEqual(ids(sortSearchMatches(docs, "date", true)), ["later", "earlier", "unknown", "invalid"]);
  assert.equal(sortSearchMatches(docs, "relevance", false), docs);
  assert.deepEqual(ids(docs), ["unknown", "later", "earlier", "invalid"]);
});

test("a context limit is not a negative answer", () => {
  const message = emptySearchMessage(
    { status: "not_evaluated", reason: "context_budget" },
    true,
    false,
  );
  assert.equal(message.title, "Answer was not checked");
  assert.match(message.body, /exceeds the answer-checking limit/);
  assert.match(message.body, /does not mean the answer is missing/);
});
test("unchecked, unavailable and genuine negative judgments stay distinct", () => {
  assert.equal(
    emptySearchMessage({ status: "not_evaluated" }, true, false).title,
    "Answer was not checked",
  );
  assert.equal(
    emptySearchMessage({ status: "unavailable" }, true, true).title,
    "Answer checking unavailable",
  );
  assert.equal(
    emptySearchMessage(
      { status: "no_answer_in_evaluated_candidates" },
      true,
      false,
    ).title,
    "No supported answer found",
  );
  assert.equal(
    emptySearchMessage({ status: "needs_context" }, true, false).title,
    "More context needed",
  );
  assert.equal(
    emptySearchMessage({ status: "not_requested" }, false, false).title,
    "No matching files",
  );
});
const match = {
  document_id: "answer",
  version: "v2",
  folder: "Project",
  groups: ["Search"],
  jev: { status: "evaluated" },
};
test("a partial or Recent browse list cannot remove a server search result", () => {
  assert.deepEqual(reconcileSearchMatches([match], [], true), [match]);
  assert.deepEqual(
    reconcileSearchMatches([match], [{ document_id: "other" }], true),
    [match],
  );
});
test("known version, status and scope changes still hide stale evidence", () => {
  for (const changes of [
    { version: "v3" },
    { status: "pending" },
    { folder: "Other" },
    { groups: [] },
  ]) {
    assert.deepEqual(
      reconcileSearchMatches(
        [match],
        [{ ...match, ...changes }],
        true,
        "Project",
        "Search",
      ),
      [],
    );
  }
  assert.deepEqual(
    reconcileSearchMatches([match], [{ ...match, version: "v3" }], false),
    [match],
  );
});
