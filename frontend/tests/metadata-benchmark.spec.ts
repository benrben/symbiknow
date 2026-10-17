import { test, expect } from "./coverage";
import fs from "node:fs/promises";
import path from "node:path";
test.skip(
  !process.env.SYMBIKNOW_METADATA_ROWS,
  "Requires isolated synthetic metadata fixture",
);
test("bounded desktop metadata benchmark", async ({ page }) => {
  const report: Record<string, unknown> = {
    hardware: "Apple M5 Pro, 18 cores, 48 GB RAM; macOS, local Chrome",
    metadata_rows: Number(process.env.SYMBIKNOW_METADATA_ROWS),
    real_documents: 7,
    providers:
      "deterministic browser fixture; no hosted model latency in these timings",
    limitations:
      "Synthetic derived metadata without originals for added rows; startup original-integrity recovery is disabled only for this benchmark fixture. Search has seven real fixture documents. Excludes real extraction, embedding, provider decisions, browser native memory and full-library original-file operations.",
  };
  let start = Date.now();
  await page.goto("/");
  await expect(page.locator(".file-row")).toHaveCount(60);
  report.initial_visible_load_ms = Date.now() - start;
  const library = await (
    await page.request.get("/api/library?limit=60")
  ).json();
  report.library_total = library.total;
  report.server_peak_rss_mib = library.benchmark_server_peak_rss_mib;
  start = Date.now();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Benchmark", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Clear folder scope" }),
  ).toContainText("Benchmark");
  await expect(page.locator(".file-row")).toHaveCount(60);
  report.folder_navigation_ms = Date.now() - start;
  await page.getByRole("button", { name: "All files", exact: true }).click();
  start = Date.now();
  await page.getByLabel("Search mode").selectOption("keyword");
  await page.getByLabel("Search your knowledge").fill("keep every version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  report.search_ms_seven_real_docs_plus_large_metadata = Date.now() - start;
  await page.getByRole("button", { name: "Clear search" }).click();
  start = Date.now();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(
    page.locator(".react-flow__node-document").first(),
  ).toBeVisible();
  report.canvas_initial_ms = Date.now() - start;
  await page
    .getByRole("button", { name: "Load more files", exact: true })
    .click();
  await expect(page.locator(".canvas-hint")).toContainText("Showing 100");
  const cards = await page.locator(".react-flow__node-document").count();
  expect(cards).toBeLessThanOrEqual(100);
  report.rendered_preview_cards = cards;
  report.working_set_documents = 100;
  start = Date.now();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  report.zoom_interaction_ms = Date.now() - start;
  const cdp = await page.context().newCDPSession(page);
  const heap = await cdp.send("Runtime.getHeapUsage");
  report.browser_js_heap_mib = heap.usedSize / 1048576;
  await fs.writeFile(
    path.resolve("../outputs/desktop-redesign/metadata-benchmark.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
});
