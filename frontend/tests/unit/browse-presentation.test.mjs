import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../../src/browsePresentation.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
});
const {
  overviewFolders,
  overviewPath,
  browseExcerpt,
  reviewMetrics,
  contextualTitle,
} = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);
const evidence = (text, headings = []) => ({ text, provenance: { headings } });
test("overview represents every aggregate folder, independent of loaded pages", () => {
  assert.deepEqual(
    overviewFolders({
      Alpha: 2,
      "Alpha / Research": 3,
      "Beta / Notes": 70,
      "": 1,
      Empty: 0,
    }),
    [
      ["Alpha", 5],
      ["Beta", 70],
      ["", 1],
    ],
  );
});
test("scoped overview separates direct files and immediate subfolders without leaking other scopes", () => {
  assert.deepEqual(
    overviewFolders(
      {
        Alpha: 2,
        "Alpha / Research": 3,
        "Alpha / Research / Deep": 4,
        Alphabet: 7,
        "": 1,
      },
      "Alpha",
    ),
    [
      ["Alpha", 2],
      ["Alpha / Research", 7],
    ],
  );
  assert.equal(
    overviewPath("Alpha / Research / Deep", "Alpha"),
    "Alpha / Research",
  );
});
test("Unfiled is a distinct scope and empty scopes remain empty", () => {
  assert.deepEqual(overviewFolders({ Alpha: 5, "": 1 }, ""), [["", 1]]);
  assert.deepEqual(overviewFolders({ Alpha: 5 }, "Missing"), []);
});
test("review metrics omit unknown counts while retaining explicit zero counts", () => {
  const job = {
    completed: 90,
    failed: 0,
    skipped: 0,
    grouping: true,
    grouped: null,
    unfiled: 0,
    links_added: null,
  };
  assert.equal(reviewMetrics(job), "90 reviewed");
  assert.equal(
    reviewMetrics({ ...job, grouped: 0, links_added: 0 }),
    "90 reviewed · 0 grouped · 0 links added",
  );
  assert.equal(
    reviewMetrics({ ...job, unfiled: 2, failed: 1, skipped: 3 }),
    "90 reviewed · 2 need a folder · 3 skipped · 1 failed",
  );
});
test("browse cards prefer actual prose over repeated heading and introductory metadata", () => {
  const prose =
    "Use a scoped folder overview to see every project, even when only the first page of documents is loaded.";
  assert.deepEqual(
    browseExcerpt([
      evidence(
        "# Overview\nKnowledge-base entry.\nSnapshot: current\nTags: interface",
        ["Overview"],
      ),
      evidence("# Design\n" + prose, ["Design"]),
    ]),
    { text: prose, heading: "Design" },
  );
});
test("metadata-only cards have no misleading preview and short source prose is preserved", () => {
  assert.equal(
    browseExcerpt([evidence("Newest first.\nLast updated: 2026-10-17")]).text,
    "",
  );
  assert.equal(
    browseExcerpt([evidence("A concise source note.")]).text,
    "A concise source note.",
  );
});

const browseURL =
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64");
const mapSource = await readFile(
  new URL("../../src/mapPresentation.ts", import.meta.url),
  "utf8",
);
const mapJS = ts
  .transpileModule(mapSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace('"./browsePresentation"', JSON.stringify(browseURL))
  .replace("'./browsePresentation'", JSON.stringify(browseURL));
const { currentMapLinks, mapSample, mapGroup, selectedMapLinks } = await import(
  "data:text/javascript;base64," + Buffer.from(mapJS).toString("base64")
);
const doc = (id, version = "v1", folder = "Alpha") => ({
  document_id: id,
  version,
  folder,
  filename: id + ".md",
  mime_type: "text/markdown",
});
const link = {
  source_document_id: "a",
  source_version: "v1",
  document_id: "b",
  version: "v2",
  relation: "related",
  source_chunk_id: "a1",
  target_chunk_id: "b1",
};
test("map only draws returned links whose exact endpoint versions are loaded", () => {
  const docs = [doc("a"), doc("b", "v2")];
  assert.deepEqual(
    currentMapLinks(docs, [
      link,
      link,
      { ...link, version: "v1" },
      { ...link, source_version: "v0" },
      { ...link, document_id: "missing" },
    ]),
    [link],
  );
});
test("map prioritizes both selected link endpoints without dropping or duplicating documents", () => {
  const docs = [doc("c"), doc("d"), doc("b", "v2"), doc("a")];
  const result = mapSample(docs, 3, "a", link);
  assert.deepEqual(
    new Set(result.map((d) => d.document_id)),
    new Set(["a", "b", "c"]),
  );
  assert.deepEqual(
    docs.map((d) => d.document_id),
    ["c", "d", "b", "a"],
  );
});
test("map preserves outside-scope connected context and Unfiled identity", () => {
  assert.equal(
    mapGroup(doc("a", "v1", "Alpha / Research / Deep"), "Alpha"),
    "Alpha / Research",
  );
  assert.equal(mapGroup(doc("b", "v1", "Beta / Notes"), "Alpha"), "Beta");
  assert.equal(mapGroup(doc("c", "v1", ""), "Alpha"), "");
});

test("reader titles remove only a repeated project prefix, without editing source content", () => {
  assert.equal(
    contextualTitle("Alpha Background.md", "Alpha / Overview"),
    "Background",
  );
  assert.equal(contextualTitle("Alphabet notes.md", "Alpha"), "Alphabet notes");
  assert.equal(
    contextualTitle("Unrelated title.md", "Alpha"),
    "Unrelated title",
  );
  assert.equal(contextualTitle("Alpha Background.md"), "Alpha Background");
});

test("connections outside the drawn map remain inspectable for the exact selected version", () => {
  assert.deepEqual(
    selectedMapLinks(doc("a"), [link, { ...link, source_version: "v0" }]),
    [link],
  );
  assert.deepEqual(selectedMapLinks(doc("b", "v2"), [link]), [link]);
  assert.deepEqual(selectedMapLinks(doc("b", "v3"), [link]), []);
});

test("10,000 metadata records keep grouping totals and exact version links correct", (t) => {
  const start = performance.now();
  const docs = Array.from({ length: 10000 }, (_, i) =>
    doc(String(i), "v1", `Project ${Math.floor(i / 100)} / Deep / Notes`),
  );
  const leaves = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`Project ${i} / Deep / Notes`, 100]),
  );
  const groups = overviewFolders(leaves);
  assert.equal(groups.length, 100);
  assert.equal(
    groups.reduce((n, [, count]) => n + count, 0),
    10000,
  );
  const links = Array.from({ length: 250 }, (_, i) => ({
    ...link,
    source_document_id: "0",
    document_id: String(i + 1),
    version: "v1",
  }));
  assert.equal(currentMapLinks(docs, links).length, 250);
  assert.equal(
    currentMapLinks(
      docs,
      links.map((l) => ({ ...l, version: "v0" })),
    ).length,
    0,
  );
  t.diagnostic(
    `10,000 records / 250 links: ${(performance.now() - start).toFixed(2)} ms (pure helpers only)`,
  );
});
