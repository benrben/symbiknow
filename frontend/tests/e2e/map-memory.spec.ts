import { chooseView } from "../support/ui-controls";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
test("100-document map pan and zoom measurement", async ({ page }) => {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const docs = Array.from({ length: 100 }, (_, i) => ({
    ...base.documents[0],
    document_id: `map-memory-${i}`,
    filename: `Map document ${i}.txt`,
    folder: `Project / Topic ${Math.floor(i / 10)}`,
    evidence: [],
  }));
  const folders = Object.fromEntries(docs.map((d) => [d.folder, 10]));
  await page.route("**/api/library?*", (r) =>
    r.fulfill({
      json: {
        ...base,
        documents: docs,
        folders,
        scoped_folders: folders,
        total: 100,
        library_total: 100,
        has_more: false,
      },
    }),
  );
  await page.route("**/api/search", (r) =>
    r.fulfill({
      json: {
        matches: docs,
        status: "ok",
        evaluation: { status: "not_evaluated" },
      },
    }),
  );
  await page.goto("/");
  await page.getByLabel("Search your knowledge").fill("map");
  await page.getByLabel("Search your knowledge").press("Enter");
  await chooseView(page, "Canvas");
  await expect(page.locator(".canvas-document").first()).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const before = await cdp.send("Performance.getMetrics");
  const times: number[] = [];
  const canvas = page.getByLabel("Folder canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    const start = Date.now();
    await page.mouse.wheel(0, i < 6 ? 160 : -160);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    times.push(Date.now() - start);
  }
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  const report = {
    mode: process.env.MAP_MODE || "all",
    pan_frame_ms: times,
    rendered_cards: await page.locator(".canvas-document").count(),
    before,
    after: await cdp.send("Performance.getMetrics"),
    heap: await cdp.send("Runtime.getHeapUsage"),
  };
  await fs.mkdir(path.join(project, "artifacts/memory-research"), { recursive: true });
  await fs.writeFile(
    path.join(project, `artifacts/memory-research/map-${report.mode}.json`),
    JSON.stringify(report, null, 2),
  );
});
