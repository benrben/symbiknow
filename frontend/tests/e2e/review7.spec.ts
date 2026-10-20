import { chooseView, setSearchMode } from "../support/ui-controls";
import { test, expect } from "../support/coverage";
import fs from "node:fs/promises";
import path from "node:path";

const shots = path.resolve(
  process.env.SYMBIKNOW_EVIDENCE_DIR
    ? process.env.SYMBIKNOW_EVIDENCE_DIR + "/review7"
    : "../artifacts/review-7-implementation/screenshots",
);
async function screenshot(page: any, name: string) {
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + ".png") });
}

test("external same-version folder moves refresh search and scope without resubmission or poll churn", async ({
  page,
}) => {
  await page.clock.install();
  let searches = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/search")) searches++;
  });
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const doc = base.documents.find(
    (d: any) => d.filename === "storage-decisions.md",
  );
  const move = async (folder: string) => {
    const result = await page.request.post("/api/move-documents", {
      headers: { Origin: "http://127.0.0.1:8766", "X-Symbiknow-UI": "1" },
      data: {
        folder,
        documents: [
          { document_id: doc.document_id, expected_version: doc.version },
        ],
      },
    });
    expect(result.ok(), await result.text()).toBeTruthy();
  };
  try {
    await page.goto("/");
    await chooseView(page, "List");
    await setSearchMode(page, "semantic");
    await page.getByLabel("Search your knowledge").fill("keep every version");
    await page.getByLabel("Search your knowledge").press("Enter");
    const row = page
      .locator(".file-row")
      .filter({ hasText: "storage-decisions" });
    await expect(row).toContainText(doc.folder);
    const before = searches;
    await move("Review / Renamed");
    await page.clock.runFor(4200);
    await expect(row).toContainText("Review / Renamed");
    await expect(row).not.toContainText("Engineering ·");
    expect(searches).toBe(before + 1);
    await screenshot(page, "01-search-refreshed");
    await page.clock.runFor(4200);
    expect(searches).toBe(before + 1);
    await chooseView(page, "Canvas");
    await expect(page.getByLabel("Search your knowledge")).toHaveValue(
      "keep every version",
    );
    await expect(
      page.locator(".canvas-title").filter({ hasText: "storage-decisions" }),
    ).toBeVisible();
    expect(searches).toBe(before + 1);
    await chooseView(page, "List");
    await page
      .getByRole("button", { name: /^Review \d+$/, exact: true })
      .click();
    await expect(row).toBeVisible();
    await move(doc.folder);
    await page.clock.runFor(4200);
    await expect(
      page.locator(".file-row").filter({ hasText: "storage-decisions" }),
    ).toHaveCount(0);
  } finally {
    await move(doc.folder);
  }
});

for (const search of [false, true]) {
  test(`desktop ${search ? "search" : "25-project overview"} keeps readable labels, fit headers and folder focus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1102, height: 864 });
    const base = await (
      await page.request.get("/api/library?limit=100")
    ).json();
    const docs = Array.from({ length: search ? 8 : 25 }, (_, i) => ({
      ...base.documents[0],
      document_id: "desktop-" + i,
      filename: `Useful document ${i}.md`,
      folder: `Project ${String(search ? Math.floor(i / 4) : i).padStart(2, "0")} / Storage`,
      jev: { status: "evaluated", label: "related" },
      evidence: [],
    }));
    const folders: Record<string, number> = {};
    for (const doc of docs)
      folders[doc.folder] = (folders[doc.folder] || 0) + 1;
    await page.route("**/api/library?*", async (route) => {
      const scope = new URL(route.request().url()).searchParams.get("folder");
      const selected = docs.filter(
        (d) =>
          !scope || d.folder === scope || d.folder.startsWith(scope + " / "),
      );
      await route.fulfill({
        json: {
          ...base,
          documents: selected,
          total: selected.length,
          has_more: false,
          folders,
          scoped_folders: Object.fromEntries(
            Object.entries(folders).filter(
              ([path]) =>
                !scope || path === scope || path.startsWith(scope + " / "),
            ),
          ),
          library_total: docs.length,
        },
      });
    });
    await page.route("**/api/search", (route) =>
      route.fulfill({
        json: {
          matches: docs,
          status: "ok",
          evaluation: { status: "evaluated" },
        },
      }),
    );
    await page.goto("/");
    await chooseView(page, "Canvas");
    if (search) {
      await page.getByLabel("Search your knowledge").fill("keep every version");
      await page.getByLabel("Search your knowledge").press("Enter");
    }
    await page
      .getByRole("button", {
        name: search ? "Fit results" : "Fit",
        exact: true,
      })
      .click();
    if (!search) await expect(page.locator(".canvas-overview")).toBeVisible();
    const effective = await page
      .locator(".frame-label")
      .first()
      .evaluate((el) => {
        const canvas = document.querySelector(".canvas")!;
        const zoom = Number(
          getComputedStyle(canvas).getPropertyValue("--canvas-zoom"),
        );
        const a = el.getBoundingClientRect(),
          b = canvas.getBoundingClientRect();
        return {
          font: parseFloat(getComputedStyle(el).fontSize) * zoom,
          top: a.top,
          inset: b.top,
        };
      });
    expect(effective.font).toBeGreaterThanOrEqual(11.5);
    expect(effective.top).toBeGreaterThan(effective.inset + 40);
    await screenshot(page, search ? "02-search-canvas" : "03-project-overview");
    const before = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    await page.locator(".react-flow__pane").hover();
    await page.mouse.wheel(0, 180);
    await expect(page.locator(".react-flow__viewport")).not.toHaveAttribute(
      "style",
      before!,
    );
    if (search)
      await expect(page.getByLabel("Search your knowledge")).toHaveValue(
        "keep every version",
      );
    else {
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      if (await page.locator(".zoom-markers").count())
        await page.locator(".canvas-group-summary button").first().click();
      else await page.locator(".frame-label").first().click();
      await expect(
        page.getByRole("button", {
          name: /^Clear folder scope(?:: .+)?$/,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^Clear folder scope(?:: .+)?$/,
          exact: true,
        }),
      ).toContainText("Project 00");
      await expect(page.locator(".canvas-overview")).toHaveCount(0);
      await screenshot(page, "04-focused-folder");
      await chooseView(page, "List");
      await screenshot(page, "05-folders-files");
    }
  });
}
