import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/features/assistant/context.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const { defaultContextPolicy, filterContext, filterCommandResult } =
  await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
const view = {
  open_document: {
    document_id: "exact-id",
    version: "v17",
    title: "Original.md",
  },
  selection: ["selected"],
  selection_documents: [{ document_id: "selected", version: "v4" }],
  scope: "folder",
  folder: "Private",
  group: "Topic",
  project: "Owner",
  folders: ["Private"],
  groups: ["Topic"],
  query: "literal query",
  visible_documents: [{ document_id: "result", version: "v2" }],
  loaded_document_count: 61,
  evidence: [{ text: "Not attached" }],
  arbitrary: "Never forwarded",
};
test("context preserves exact identities but does not invent content attachments", () => {
  const result = filterContext(view, defaultContextPolicy);
  assert.deepEqual(result.open_document, view.open_document);
  assert.equal(result.loaded_document_count, 61);
  assert.equal(result.project, "Owner");
  assert.equal(result.evidence, undefined);
  assert.equal(result.arbitrary, undefined);
});
test("narrowing to the open file removes selection, taxonomy and query/result identities", () => {
  const policy = {
    open_document: true,
    selection: false,
    scope: false,
    results: false,
  };
  assert.deepEqual(filterContext(view, policy), {
    context_policy: policy,
    open_document: view.open_document,
  });
  assert.equal(view.folder, "Private");
});
test("cleared context contains no view metadata and the latest policy filters asynchronous command replies", () => {
  const policy = {
    open_document: false,
    selection: false,
    scope: false,
    results: false,
  };
  const raw = { ok: true, completed: true, state: view };
  assert.deepEqual(filterCommandResult(raw, policy), {
    ok: true,
    completed: true,
    state: { context_policy: policy },
  });
  assert.deepEqual(filterContext(view, policy), { context_policy: policy });
  assert.equal(raw.state, view);
});
