import { test, expect, type Page } from "@playwright/test";
import { fixture, audit } from "./quality-fixture";

async function navigation(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Folders — toggle library navigation",
  });
  if (await toggle.isVisible()) await toggle.tap();
  return toggle;
}
async function reflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("navigation exposes current scope and supports Escape with focus return", async ({
  page,
}) => {
  await fixture(page);
  const toggle = await navigation(page);
  const nav = page.getByRole("navigation", { name: "Library navigation" });
  await expect(
    nav.getByRole("button", { name: "All files 70", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("searchbox", { name: "Find a folder" })
    .fill("missing folder");
  await expect(nav.getByRole("status")).toHaveText("No matching folders.");
  if (await toggle.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(nav).toBeHidden();
    await toggle.tap();
  }
  await nav.getByRole("button", { name: "Recent", exact: true }).tap();
  if (await toggle.isVisible()) await toggle.tap();
  await expect(
    nav.getByRole("button", { name: "Recent", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    nav.getByRole("button", { name: "All files 70", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
});

test("touch controls and editable text remain comfortably sized", async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
  ).toBe(true);
  await navigation(page);
  for (const control of [
    page.getByRole("searchbox", { name: "Find a folder" }),
    page.getByLabel("Search your knowledge"),
  ]) {
    expect(
      await control.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  }
  const controls = page.locator(
    ".segmented button, .mobile-navigation-toggle, .folder-label, .folder-nav-row .icon:not(:disabled)",
  );
  for (const control of await controls.all()) {
    if (!(await control.isVisible())) continue;
    const rect = await control.boundingBox();
    expect(
      rect!.height,
      (await control.getAttribute("aria-label")) || (await control.innerText()),
    ).toBeGreaterThanOrEqual(44);
  }
  await audit(page, "touch navigation");
});

test("touch reader survives rotation and a reduced keyboard viewport", async ({
  page,
}, testInfo) => {
  await fixture(page);
  const origin = page.getByRole("button", { name: "Open Guide", exact: true });
  await origin.tap();
  const close = page.getByRole("button", {
    name: /^(Back to library|Close inspector)$/,
  });
  await expect(close).toBeFocused();
  const find = page.getByRole("searchbox", { name: "Find in document" });
  await find.tap();
  await find.fill("Needle");
  await expect(page.locator(".reader-tools output")).toHaveText("1 / 24");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.height, height: size.width });
  await reflow(page);
  await expect(find).toHaveValue("Needle");
  await audit(page, "landscape reader");
  await page.setViewportSize({
    width: size.width,
    height: Math.max(320, Math.round(size.height * 0.55)),
  });
  await find.tap();
  await find.fill("a+b?");
  await expect(page.locator(".reader-tools output")).toHaveText("1 / 1");
  await reflow(page);
  await close.tap();
  await expect(origin).toBeFocused();
  await page.setViewportSize(size);
  await page.screenshot({
    path: testInfo.outputPath("mobile-overview.png"),
    fullPage: true,
  });
});

test("touch filters trap focus, dismiss, and recover from empty search", async ({
  page,
}) => {
  await fixture(page);
  const filters = page.getByRole("button", {
    name: /^Search scope and filters/,
  });
  await filters.tap();
  const dialog = page.getByRole("dialog", { name: "Search filters" });
  await expect(dialog).toBeVisible();
  await audit(page, "touch filters");
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(filters).toBeFocused();
  await page.getByLabel("Search your knowledge").fill("missing");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(
    page.getByRole("heading", { name: "No matching files" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to browsing", exact: true })
    .tap();
  await expect(page.getByLabel("Folder overview")).toBeVisible();
  await reflow(page);
});

test("touch list, cards and map keep selection and reader focus usable", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "List", exact: true }).tap();
  await page
    .getByRole("button", { name: "Select Guide.md", exact: true })
    .tap();
  await expect(
    page.getByRole("button", { name: "Select Guide.md", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await reflow(page);
  await page.getByRole("button", { name: "Cards", exact: true }).tap();
  const preview = page.getByRole("button", {
    name: "Preview Guide",
    exact: true,
  });
  await preview.tap();
  await page
    .getByRole("button", { name: "Back to library", exact: true })
    .tap();
  await expect(preview).toBeFocused();
  await page.getByRole("button", { name: "Map", exact: true }).tap();
  await page.getByRole("searchbox", { name: "Find map files" }).fill("Guide");
  await page
    .getByRole("button", { name: "Select map file Guide v2", exact: true })
    .tap();
  const read = page.getByRole("button", { name: "Read document", exact: true });
  await read.tap();
  await page
    .getByRole("button", { name: "Back to library", exact: true })
    .tap();
  await expect(read).toBeFocused();
  await reflow(page);
  await audit(page, "touch map selection");
});
