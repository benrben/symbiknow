import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export async function fixture(page: Page) {
  const documents = Array.from({ length: 70 }, (_, i) => ({
    document_id: `quality-${i}`,
    version: "v2",
    filename: i === 0 ? "Guide.md" : `Note ${String(i).padStart(2, "0")}.md`,
    folder: "Research / Guides",
    mime_type: "text/markdown",
    size: 12000,
    status: "indexed",
    organization_status: "evaluated",
    created_at: "2026-10-17T09:00:00Z",
  }));
  const evidence = (i: number) => ({
    evidence_id: `quality-${i}:v2:t0`,
    text: "Original source evidence: preserve exact versions.",
    provenance: { headings: ["Evidence"] },
  });
  const link = {
    source_document_id: "quality-0",
    source_version: "v2",
    document_id: "quality-1",
    version: "v2",
    source_filename: "Guide.md",
    target_filename: "Note 01.md",
    source_chunk_id: "quality-0:v2:t0",
    target_chunk_id: "quality-1:v2:t0",
    relation: "supports",
  };
  let failPassages = true;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      q = url.searchParams,
      endpoint = url.pathname.split("/").at(-1);
    const i = Number((q.get("id") || "quality-0").split("-").at(-1)),
      doc = documents[i] || documents[0];
    if (endpoint === "freshness")
      return route.fulfill({
        json: { scan: null, findings: [], has_more: false, next_after: "", recent_scans: [] },
      });
    if (endpoint === "library") {
      const offset = Number(q.get("offset") || 0),
        limit = Number(q.get("limit") || 60);
      return route.fulfill({
        json: {
          documents: documents.slice(offset, offset + limit),
          total: 70,
          library_total: 70,
          has_more: offset + limit < 70,
          folders: { "Research / Guides": 70 },
          scoped_folders: { "Research / Guides": 70 },
          groups: ["Research review"],
          processing: false,
          processing_states: {},
          library_id: "quality-library",
          index_revision: "fixed",
          organization_revision: "fixed",
          max_file_bytes: 268435456,
          max_chunk_bytes: 262144,
        },
      });
    }
    if (endpoint === "document")
      return route.fulfill({
        json: {
          document: { ...doc, version: q.get("version") || "v2" },
          current_version: "v2",
          organization: doc,
          evidence: [evidence(i)],
          connections: i === 0 ? [link] : [],
          versions: [{ ...doc, version: "v1" }, doc],
        },
      });
    if (endpoint === "original")
      return route.fulfill({
        contentType: "text/plain",
        body:
          `# ${doc.filename}\n\nLiteral a+b? and **inline emphasis** are searchable.\n\n` +
          Array.from(
            { length: 24 },
            (_, n) =>
              `## Section ${n + 1}\n\nNeedle ${n + 1}. ${"A readable paragraph retains the original text and precise version. ".repeat(8)}\n\n`,
          ).join(""),
      });
    if (endpoint === "card")
      return route.fulfill({ json: { evidence: [evidence(i)] } });
    if (endpoint === "neighborhood")
      return route.fulfill({
        json: { documents: documents.slice(0, 2), links: [link] },
      });
    if (endpoint === "link") {
      return failPassages
        ? route.fulfill({
            status: 503,
            json: { error: "Temporary evidence failure" },
          })
        : route.fulfill({
            json: { source: [evidence(0)], target: [evidence(1)], link },
          });
    }
    if (endpoint === "rebuild")
      return route.fulfill({
        json: {
          request_id: "quality-job",
          status: "completed",
          mode: "links",
          total: 70,
          completed: 70,
          failed: 0,
          skipped: 0,
          links_added: 1,
          details: [],
          failures: {},
          folder: null,
          grouping: false,
          links: true,
        },
      });
    if (endpoint === "history")
      return route.fulfill({
        json: {
          versions: [doc, { ...doc, version: "v1" }],
          has_more: false,
          head: "v2",
        },
      });
    if (endpoint === "search")
      return route.fulfill({
        json: { matches: [], evaluation: { status: "not_requested" } },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  return {
    documents,
    recoverPassages: () => {
      failPassages = false;
    },
  };
}
export async function openGuide(page: Page) {
  await page.getByRole("button", { name: "Open Guide", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Find in document" }),
  ).toBeVisible();
}
export async function audit(page: Page, label: string) {
  const builder = () =>
    new AxeBuilder({ page }).withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
    ]);
  const describe = (violations: any[]) =>
    violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n: any) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    }));
  const result = await builder().analyze();
  expect(
    describe(result.violations.filter((v) => v.id !== "target-size")),
    label,
  ).toEqual([]);
  // Scroll-container edges can clip an otherwise full-sized target. Bring each
  // reported control into view, then apply the same rule with its neighbors.
  for (const node of result.violations
    .filter((v) => v.id === "target-size")
    .flatMap((v) => v.nodes)) {
    const selector = node.target[0] as string;
    await page
      .locator(selector)
      .evaluate((el) =>
        el.scrollIntoView({ block: "center", inline: "nearest" }),
      );
    const checked = await builder().include(selector).analyze();
    expect(
      describe(checked.violations),
      `${label}: ${selector} after scrolling into view`,
    ).toEqual([]);
  }
}
