import { chooseView, setAnswerChecking } from "./ui-controls";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const out = path.resolve("../outputs/review9-combined-fixes/ui");
const question = "Does Symbiknow use Git to preserve previous file contents?";
async function fixture(page: Page, count = 40) {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const docs = Array.from({ length: count }, (_, i) => {
    const id = `review9-${i}`;
    const evidence = [
      {
        evidence_id: `${id}:v2:t0`,
        text:
          "# Introductory context\n\n" +
          "Background about installation. ".repeat(45),
        basis: "text",
        provenance: { headings: ["Introduction"] },
      },
      {
        evidence_id: `${id}:v2:t1`,
        text:
          "# Storage\n\n" +
          "Additional installation background. ".repeat(20) +
          "Symbiknow preserves previous file contents in OCFL without Git. Earlier versions remain available.",
        basis: "text",
        provenance: { page: 3 },
      },
    ];
    const labels = ["direct", "partial", "related", "unrelated", "uncertain"];
    return {
      ...base.documents[0],
      document_id: id,
      filename:
        i === 0
          ? "Symbiknow README with a very long document title.md"
          : `Policy ${i}.md`,
      mime_type: "text/markdown",
      version: "v2",
      folder: i === 0 ? "Symbiknow" : `Symbiknow / Topic ${i % 8}`,
      evidence,
      jev: {
        status:
          i === 7 ? "unavailable" : i === 8 ? "not_evaluated" : "evaluated",
        label: labels[i % 5],
        coverage: i === 9 ? "unknown" : "complete",
        supporting_chunk_ids:
          i === 3 || i === 7 || i === 8 ? [] : [evidence[1].evidence_id],
        conflicting_chunk_ids: i === 5 ? [evidence[1].evidence_id] : [],
        possible_conflicting_chunk_ids:
          i === 6 ? [evidence[1].evidence_id] : [],
        evidence_disagreement: i === 4 ? "accepted" : "none_detected",
        disagreement_chunk_ids: i === 4 ? [evidence[1].evidence_id] : [],
        explanation:
          "Answer evidence says no Git; full decision explanation is accessible here.",
        evaluated_evidence: [
          {
            chunk_id: evidence[1].evidence_id,
            text: evidence[1].text,
            location: evidence[1].provenance,
          },
        ],
      },
    };
  });
  const folders: Record<string, number> = {};
  docs.forEach((d) => (folders[d.folder] = (folders[d.folder] || 0) + 1));
  await page.route("**/api/library?*", (route) =>
    route.fulfill({
      json: {
        ...base,
        library_id: base.library_id + "-review9",
        documents: docs,
        total: docs.length,
        has_more: false,
        folders,
        scoped_folders: folders,
        processing: false,
        index_revision: "static9",
        organization_revision: "static9",
      },
    }),
  );
  const requests: any[] = [];
  await page.route("**/api/search", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        status: "ok",
        matches: docs,
        evaluation: { status: "evaluated" },
      },
    });
  });
  await page.route("**/api/document?*", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const d = docs.find((d) => d.document_id === q.get("id"))!;
    return route.fulfill({
      json: {
        document: { ...d, version: q.get("version") },
        current_version: "v2",
        organization: d,
        evidence: d.evidence,
        connections: [],
        versions: [{ ...d, version: "v1" }, d],
      },
    });
  });
  await page.route("**/api/original?*", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body:
        "# Long original\n\n" +
        "The original document remains readable and version pinned. ".repeat(
          400,
        ),
    }),
  );
  await page.goto("/");
  await chooseView(page, "List");
  await page
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  await setAnswerChecking(page, true);
  await page.getByLabel("Search your knowledge").fill(question);
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".file-row")).toHaveCount(count);
  return { docs, requests };
}
async function snap(page: Page, name: string) {
  await fs.mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name + ".png") });
}
for (const size of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1728, height: 1117 },
])
  for (const inspector of [false, true]) {
    test(`forty matches nine frames fit and navigate ${size.width} inspector ${inspector}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const data = await fixture(page);
      if (inspector) await page.locator(".file-select").first().press("Enter");
      await chooseView(page, "Canvas");
      await page
        .getByRole("button", { name: "Fit results", exact: true })
        .click();
      await expect(page.locator(".react-flow__node-folder")).toHaveCount(9);
      await expect(page.locator(".react-flow__node-document")).toHaveCount(40);
      const geometry = await page.locator(".canvas").evaluate((el) => {
        const box = el.getBoundingClientRect();
        const frames = [...el.querySelectorAll(".react-flow__node-folder")].map(
          (n) => n.getBoundingClientRect(),
        );
        const nodes = [
          ...el.querySelectorAll(".react-flow__node-document"),
        ].map((n) => n.getBoundingClientRect());
        return {
          zoom: Number(getComputedStyle(el).getPropertyValue("--canvas-zoom")),
          width: box.width,
          columns: new Set(frames.map((r) => Math.round(r.x))).size,
          inside: nodes.every(
            (r) =>
              r.left >= box.left - 1 &&
              r.right <= box.right + 1 &&
              r.top >= box.top &&
              r.bottom <= box.bottom,
          ),
          overlap: frames.some((a, i) =>
            frames
              .slice(i + 1)
              .some(
                (b) =>
                  a.left < b.right - 1 &&
                  a.right > b.left + 1 &&
                  a.top < b.bottom - 1 &&
                  a.bottom > b.top + 1,
              ),
          ),
        };
      });
      expect(geometry.overlap).toBe(false);
      expect(geometry.inside).toBe(true);
      if (geometry.width >= 848)
        expect(geometry.columns).toBeGreaterThanOrEqual(2);
      await snap(page, `fit-${size.width}-inspector-${inspector}`);
      for (let i = 0; i < 10; i++)
        await page
          .getByRole("button", { name: "Zoom out", exact: true })
          .click();
      const groups = page.getByRole("navigation", {
        name: "Folder groups at low zoom",
      });
      await expect(groups).toBeVisible();
      await expect(groups).toContainText("1 match");
      const calls = data.requests.length;
      await groups.getByRole("button", { name: /Topic 1/ }).click();
      await expect(page.locator(".zoom-detail")).toBeVisible();
      expect(data.requests.length).toBe(calls);
      await fs.writeFile(
        path.join(out, `geometry-${size.width}-${inspector}.json`),
        JSON.stringify(geometry, null, 2),
      );
    });
  }
test("all decision rectangles remain disjoint at detail and summary scales, evidence is keyboard reachable", async ({
  page,
}) => {
  const data = await fixture(page, 10);
  await chooseView(page, "Canvas");
  await expect(page.locator(".react-flow__node-document")).toHaveCount(10);
  const records = [];
  // Seed only viewport; automatic packing and selected identities remain real.
  for (const zoom of [1, 0.75, 0.46]) {
    await chooseView(page, "List");
    await page.evaluate((z) => {
      const key = Object.keys(localStorage).find((k) =>
        k.includes("canvas:Symbiknow|search:"),
      )!;
      const v = JSON.parse(localStorage.getItem(key)!);
      v.overview = false;
      v.viewport = { x: 0, y: 60, zoom: z };
      localStorage.setItem(key, JSON.stringify(v));
    }, zoom);
    await chooseView(page, "Canvas");
    await expect(page.locator(".canvas-document")).toHaveCount(10);
    await expect(page.locator(".zoom-percent")).toHaveText(
      `${Math.round(zoom * 100)}%`,
    );
    const g = await page.locator(".canvas-document").evaluateAll((cards) =>
      cards.map((c) => {
        const outer = c.getBoundingClientRect();
        const rs = [
          ".card-handle",
          ".canvas-meta",
          ".content-card",
          ".canvas-judgment",
        ]
          .map((s) => c.querySelector(s)!)
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.getBoundingClientRect());
        return {
          contained: rs.every(
            (r) =>
              r.left >= outer.left - 1 &&
              r.right <= outer.right + 1 &&
              r.top >= outer.top - 1 &&
              r.bottom <= outer.bottom + 1,
          ),
          overlap: rs.some((a, i) =>
            rs
              .slice(i + 1)
              .some(
                (b) =>
                  a.left < b.right &&
                  a.right > b.left &&
                  a.top < b.bottom - 0.5 &&
                  a.bottom > b.top + 0.5,
              ),
          ),
        };
      }),
    );
    if (zoom === 1) {
      const excerpt = await page
        .locator('.canvas-document[data-document-id="review9-0"] .content-card')
        .evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            const index = (text.textContent || "").indexOf("without Git");
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + 11);
            const phrase = range.getBoundingClientRect(),
              preview = el.getBoundingClientRect();
            return (
              phrase.top >= preview.top && phrase.bottom <= preview.bottom + 1
            );
          }
          return false;
        });
      expect(excerpt).toBe(true);
    }
    expect(g).toHaveLength(10);
    expect(g.every((r) => r.contained && !r.overlap)).toBe(true);
    records.push({ zoom, rectangles: g });
    await snap(page, `decisions-${zoom}`);
  }
  expect(data.requests.length).toBe(1);
  await fs.writeFile(
    path.join(out, "decision-geometry.json"),
    JSON.stringify(records, null, 2),
  );
});
test("long original evidence actions in every view use accepted window and version, with no retrieval", async ({
  page,
}) => {
  const data = await fixture(page, 10);
  const expected = data.docs[0].evidence[1].evidence_id;
  for (const view of ["List", "Cards", "Canvas"]) {
    await chooseView(page, view);
    if (view === "Canvas")
      await page.locator(".canvas-title").first().press("Enter");
    else await page.locator(".file-select").first().press("Enter");
    await expect(page.locator(".search-context")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "View evidence", exact: true }),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "View evidence", exact: true })
      .press("Enter");
    await expect(
      page.getByRole("region", { name: "Search evidence" }),
    ).toBeFocused();
    await expect(page.locator(`[id="evidence-${expected}"]`)).toContainText(
      "without Git",
    );
    await expect(page.locator(".why-file")).toContainText(
      "Supporting evidence · v2 · Page 3",
    );
    await snap(page, `evidence-${view}`);
    await page
      .getByRole("button", {
        name: /^(Back to library|Close inspector)$/,
        exact: true,
      })
      .click();
  }
  await chooseView(page, "Cards");
  await expect(
    page.locator(".grid-file").first().locator(".card-prose"),
  ).toContainText(
    "Symbiknow preserves previous file contents in OCFL without Git",
  );
  const action = page.getByRole("button", {
    name: `View evidence for ${data.docs[0].filename}`,
    exact: true,
  });
  await action.press("Enter");
  await expect(page.locator(".why-file")).toBeVisible();
  await page.getByLabel("Preview version").selectOption("v1");
  await expect(page.locator(".why-file")).toHaveCount(0);
  await expect(page.locator(".search-context")).toHaveCount(0);
  await expect(page.getByLabel("Download v1")).toHaveAttribute(
    "href",
    /version=v1/,
  );
  expect(data.requests.length).toBe(1);
  await fs.writeFile(
    path.join(out, "evidence-request-counts.json"),
    JSON.stringify(
      {
        query: question,
        searchRequests: data.requests,
        acceptedId: expected,
        views: ["List", "Cards", "Canvas"],
        historicalEvidenceRemoved: true,
      },
      null,
      2,
    ),
  );
});
