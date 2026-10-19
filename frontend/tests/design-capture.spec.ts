import { chooseView } from "./ui-controls";
import { test, expect } from "./coverage";
import fs from "node:fs/promises";
import path from "node:path";
// Explicitly opt in to the separate 12-document screenshot library.
test.skip(
  !process.env.SYMBIKNOW_DESIGN_FIXTURE,
  "Requires the isolated design fixture",
);
const output = path.resolve("../outputs/desktop-redesign");
test("Files, folders and Canvas design references with twelve real repository document copies", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fs.mkdir(output, { recursive: true });
  await page.goto("/");
  await expect(page.getByText("12 files", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Expand Symbiknow", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /^Select Symbiknow UI guide(?:\.[^.]+)?$/,
      exact: true,
    })
    .press("Enter");
  await expect(page.getByLabel("Document inspector")).toContainText(
    "Symbiknow human interface",
  );
  await page.screenshot({ path: path.join(output, "files-view.png") });
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1102, height: 808 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: path.join(output, `files-view-${size.width}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", {
      name: /^(Back to library|Close inspector)$/,
      exact: true,
    })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  await chooseView(page, "Cards");
  await expect(page.locator(".file-grid .file-row")).toHaveCount(7);
  for (let i = 0; i < 3; i++)
    await expect(
      page.locator(".file-grid .file-row").nth(i).locator(".card-prose"),
    ).not.toBeEmpty();
  await page.screenshot({ path: path.join(output, "folders-view.png") });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(7);
  await expect(page.locator(".canvas .card-prose").first()).toBeVisible();
  await page.screenshot({ path: path.join(output, "canvas-view.png") });
  await page
    .getByRole("button", {
      name: /^Select Symbiknow architecture(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.screenshot({ path: path.join(output, "canvas-links.png") });
  await chooseView(page, "List");
  await page.getByLabel("Search your knowledge").fill("original file versions");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  await page.screenshot({ path: path.join(output, "search-view.png") });
  expect(errors).toEqual([]);
});
