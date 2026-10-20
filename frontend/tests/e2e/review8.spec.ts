import { chooseView, setSearchMode, setAnswerChecking } from "../support/ui-controls";
import { test, expect } from "../support/coverage";
import fs from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve(
  process.env.SYMBIKNOW_EVIDENCE_DIR
    ? process.env.SYMBIKNOW_EVIDENCE_DIR + "/review8"
    : "../artifacts/review-8-implementation",
  process.env.REVIEW8_STAGE || "after",
);
async function record(page: any, name: string, value: unknown) {
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(
    path.join(evidence, name + ".json"),
    JSON.stringify(value, null, 2),
  );
  await page.screenshot({ path: path.join(evidence, name + ".png") });
}

async function fixture(page: any) {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const docs = Array.from({ length: 18 }, (_, i) => {
    const id = "review8-" + i;
    const passage = {
      evidence_id: id + ":v1:t0",
      text: "Canvasrevieweight retains every original version.",
      basis: "text",
      provenance: {},
    };
    return {
      ...base.documents[0],
      document_id: id,
      version: "v1",
      filename: `Review topic ${Math.floor(i / 2)} document ${i % 2}.md`,
      folder: `Canvas review / Topic ${Math.floor(i / 2)}`,
      evidence: [passage],
      jev: {
        status: i < 8 ? "evaluated" : "not_evaluated",
        label: i % 2 ? "uncertain" : "direct",
        supporting_chunk_ids: i % 2 ? [] : [passage.evidence_id],
      },
    };
  });
  const folders = Object.fromEntries(docs.map((d) => [d.folder, 2]));
  return {
    library: {
      ...base,
      documents: docs,
      folders,
      scoped_folders: folders,
      total: 18,
      library_total: 18,
      has_more: false,
    },
    docs,
  };
}

for (const mode of ["hybrid", "keyword", "semantic"]) {
  test(`many folders retain all search matches, ranks and readable judgments in ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1102, height: 864 });
    const { library, docs } = await fixture(page);
    await page.route("**/api/library?*", (route) =>
      route.fulfill({ json: library }),
    );
    const requests: any[] = [];
    await page.route("**/api/search", (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          matches: docs,
          evaluation: { status: "evaluated" },
          status: "ok",
        },
      });
    });
    await page.goto("/");
    await chooseView(page, "List");
    await page
      .getByRole("button", { name: /^Canvas review \d+$/, exact: true })
      .click();
    await setSearchMode(page, mode);
    await setAnswerChecking(page, true);
    await page.getByLabel("Search your knowledge").fill("Canvasrevieweight");
    await page.getByLabel("Search your knowledge").press("Enter");
    await expect(page.locator(".file-row")).toHaveCount(18);
    const files = await page
      .locator(".file-row button[aria-label^='Select ']")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("aria-label")?.replace(/\.md$/, "")),
      );
    await record(page, `${mode}-files`, { files, requests });
    await chooseView(page, "Canvas");
    await page
      .getByRole("button", { name: "Fit results", exact: true })
      .click();
    await expect(page.locator(".react-flow__node-folder")).toHaveCount(9);
    const cards = await page
      .locator(".react-flow__node-document")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          id: n.getAttribute("data-id"),
          title: n.querySelector(".canvas-title")?.getAttribute("aria-label"),
          rank: n.querySelector(".canvas-judgment > small")?.textContent,
        })),
      );
    const font = await page
      .locator(".canvas-judgment .judgment")
      .evaluateAll((nodes) => {
        const zoom = Number(
          getComputedStyle(document.querySelector(".canvas")!).getPropertyValue(
            "--canvas-zoom",
          ),
        );
        return nodes.map((n) => ({
          text: n.textContent,
          px: parseFloat(getComputedStyle(n).fontSize) * zoom,
        }));
      });
    await record(page, `${mode}-canvas`, { cards, font, requests });
    expect(cards.map((c) => c.title).sort()).toEqual(files.sort());
    expect(cards.map((c) => c.id).sort()).toEqual(
      docs.map((d) => d.document_id).sort(),
    );
    // Browser computed styles serialize font sizes to finite decimal precision.
    // Detailed decisions use fixed type within reserved rows. At semantic
    // overview scale, readable group navigation replaces shrinking labels.
    await expect
      .poll(() =>
        page.locator(".canvas").evaluate((el) => {
          const zoom = Number(
            getComputedStyle(el).getPropertyValue("--canvas-zoom"),
          );
          const decisions = [
            ...el.querySelectorAll(".canvas-judgment .judgment"),
          ];
          const detailReadable =
            zoom >= 0.75 &&
            decisions.every(
              (d) => parseFloat(getComputedStyle(d).fontSize) === 12,
            );
          const groups = el.querySelector(".canvas-group-summary");
          return (
            detailReadable ||
            (!!groups &&
              getComputedStyle(groups).fontSize === "12px" &&
              groups.querySelectorAll("button").length === 9)
          );
        }),
      )
      .toBe(true);
    for (const card of cards)
      expect(card.rank).toBe(
        "#" + (docs.findIndex((d) => d.document_id === card.id) + 1),
      );
    const calls = requests.length;
    await page
      .locator(".canvas")
      .getByRole("button", { name: "Collapse Topic 0", exact: true })
      .click();
    await expect(page.locator(".react-flow__node-document")).toHaveCount(16);
    await expect(page.locator(".folder-heading").first()).toContainText(
      "2 matches",
    );
    await page
      .locator(".canvas")
      .getByRole("button", { name: "Expand Topic 0", exact: true })
      .click();
    await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
    const viewport = page.locator(".react-flow__viewport");
    const before = await viewport.getAttribute("style");
    await page.locator(".react-flow__pane").hover();
    await page.mouse.wheel(0, 250);
    await expect(viewport).not.toHaveAttribute("style", before!);
    await expect(page.getByLabel("Search your knowledge")).toHaveValue(
      "Canvasrevieweight",
    );
    expect(requests.length).toBe(calls);
    await expect(
      page.getByRole("button", { name: /^Clear folder scope(?:: .+)?$/ }),
    ).toContainText("Canvas review");
    await chooseView(page, "List");
    await expect(page.locator(".file-row")).toHaveCount(18);
    expect(requests.length).toBe(calls);
  });
}

test("revision churn queues one refresh without canceling a slow search and keeps completed results visible", async ({
  page,
}) => {
  await page.clock.install();
  const { library, docs } = await fixture(page);
  let revisions = 0,
    requests = 0;
  await page.route("**/api/library?*", (route) =>
    route.fulfill({
      json: { ...library, organization_revision: "revision-" + revisions++ },
    }),
  );
  let releaseFirst!: () => void, releaseNext!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const next = new Promise<void>((resolve) => (releaseNext = resolve));
  await page.route("**/api/search", async (route) => {
    const n = ++requests;
    await (n === 1 ? first : next);
    await route.fulfill({
      json: {
        matches: docs,
        evaluation: { status: "evaluated" },
        status: "ok",
      },
    });
  });
  try {
    await page.goto("/");
    await chooseView(page, "List");
    await page.getByLabel("Search your knowledge").fill("Canvasrevieweight");
    await page.getByLabel("Search your knowledge").press("Enter");
    await expect.poll(() => requests).toBe(1);
    for (let i = 0; i < 3; i++) {
      const old = revisions;
      await page.clock.runFor(4200);
      await expect.poll(() => revisions).toBeGreaterThan(old);
    }
    await record(page, "pending-search-churn", { requests, revisions });
    expect(requests).toBe(1);
    releaseFirst();
    await expect(page.locator(".file-row")).toHaveCount(18);
    await expect.poll(() => requests).toBe(2);
    await expect(
      page.getByText("Refreshing search results…", { exact: true }),
    ).toBeVisible();
    await record(page, "completed-results-during-refresh", {
      requests,
      revisions,
    });
    releaseNext();
    await expect(
      page.getByText("Refreshing search results…", { exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseFirst();
    releaseNext();
  }
});

test("a slow library poll completes without overlapping polls discarding its response", async ({
  page,
}) => {
  await page.clock.install();
  const { library, docs } = await fixture(page);
  let requests = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/progress", (route) =>
    route.fulfill({
      json: {
        index_revision: "changed-for-slow-poll",
        organization_revision: library.organization_revision,
        processing: false,
      },
    }),
  );
  await page.route("**/api/library?*", async (route) => {
    const n = ++requests;
    if (n > 1) await gate;
    const late = {
      ...docs[0],
      document_id: "late-indexed",
      filename: "Added status file.md",
      folder: "Other",
    };
    await route.fulfill({
      json:
        n === 1
          ? library
          : {
              ...library,
              documents: [...docs, late],
              total: 19,
              library_total: 19,
              folders: { ...library.folders, Other: 1 },
              scoped_folders: { ...library.folders, Other: 1 },
            },
    });
  });
  try {
    await page.goto("/");
    await chooseView(page, "List");
    await expect(
      page.getByRole("button", { name: /^All files \d+$/, exact: true }),
    ).toContainText("18");
    await page.clock.runFor(4200);
    await expect.poll(() => requests).toBe(2);
    await page.clock.runFor(8400);
    expect(requests).toBe(2);
    release();
    await expect(
      page.getByRole("button", { name: /^All files \d+$/, exact: true }),
    ).toContainText("19");
    await record(page, "library-poll-coalescing", { requests });
  } finally {
    release();
  }
});
