import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/features/search/presentation.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
});
const { emptySearchMessage, reconcileSearchMatches, sortSearchMatches, unavailableAnswerMessage } = await import(
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
test("files withheld for likely credentials are not a negative answer", () => {
  const message = emptySearchMessage(
    { status: "not_evaluated", reason: "sensitive_content" },
    true,
    false,
  );
  assert.equal(message.title, "Answer was not checked");
  assert.match(message.body, /may contain credentials/);
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

test("billing failures explain the required fix before another check", () => {
  const message = emptySearchMessage({
    status: "unavailable",
    failure: {
      code: "billing_required",
      message: "Jev could not check the evidence because the provider rejected billing.",
      retryable: false,
      recovery: "Check credits and billing for the configured Jev provider account, then retry the check.",
      http_status: 402,
    },
  }, true, true);
  assert.equal(message.title, "Answer checking unavailable");
  assert.match(message.body, /provider rejected billing/);
  assert.match(message.body, /Check credits and billing.*then retry/);
  assert.match(message.body, /does not mean the answer is missing/);
  assert.match(message.body, /browse related files/);
  assert.doesNotMatch(message.body, /Retry the check or/);
});

test("transient provider failures retain the provider's recovery advice", () => {
  const message = unavailableAnswerMessage({
    status: "unavailable",
    failure: {
      code: "rate_limited",
      message: "Jev is temporarily rate limited by the provider.",
      retryable: true,
      recovery: "Wait for the provider's rate limit to reset, then retry the check.",
      http_status: 429,
    },
  });
  assert.match(message.body, /temporarily rate limited/);
  assert.match(message.body, /Wait for.*rate limit to reset, then retry/);
});

test("nonretryable failures do not acquire generic retry advice", () => {
  const message = unavailableAnswerMessage({
    status: "unavailable",
    failure: {
      code: "permission_denied",
      message: "The provider denied access to Jev.",
      retryable: false,
      recovery: "Check the configured provider account's permissions and model access.",
    },
  });
  assert.match(message.body, /permissions and model access/);
  assert.doesNotMatch(message.body, /retry|try again/i);
});

test("legacy unavailable responses neither invent a cause nor promise retry will help", () => {
  const message = unavailableAnswerMessage({ status: "unavailable" });
  assert.match(message.body, /could not be completed/);
  assert.match(message.body, /does not mean the answer is missing/);
  assert.match(message.body, /browse related files/);
  assert.doesNotMatch(message.body, /billing|retry|try again/i);
});

test("partial provider failures preserve the meaning of already checked answers", () => {
  const message = unavailableAnswerMessage({ status: "unavailable" }, true);
  assert.match(message.body, /Only previously accepted answers are shown/);
  assert.match(message.body, /browse related files/);
  assert.doesNotMatch(message.body, /answer is missing/);
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
