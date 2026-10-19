import { test, expect } from "@playwright/test";
import { fixture, openGuide, audit } from "./quality-fixture";

test("reader literal search, keyboard shortcuts, position restoration and paged file navigation", async ({
  page,
}) => {
  await fixture(page);
  await openGuide(page);
  const find = page.getByRole("searchbox", { name: "Find in document" });
  await find.fill("a+b?");
  await expect(page.locator(".reader-tools output")).toHaveText("1 / 1");
  await find.fill("Needle");
  await expect(page.locator(".reader-tools output")).toHaveText("1 / 24");
  await find.press("Enter");
  await expect(page.locator(".reader-tools output")).toHaveText("2 / 24");
  await find.press("Shift+Enter");
  await expect(page.locator(".reader-tools output")).toHaveText("1 / 24");
  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("On this page", { exact: true })
    .selectOption({ label: " Section 20" });
  const scroll = await page
    .locator(".inspector-content")
    .evaluate((el) => el.scrollTop);
  expect(scroll).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "Read Note 01", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Note 01.md", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Read Guide", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resumed · Back to top", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".inspector-content").evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(scroll - 100);
  await page.getByRole("button", { name: "Next files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Read Note 69", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Resumed · Back to top", exact: true })
    .click();
  await expect
    .poll(() =>
      page.locator(".inspector-content").evaluate((el) => el.scrollTop),
    )
    .toBe(0);
});

test("map coverage, filtered files, evidence retry and keyboard focus restoration", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator(".map-context-bar")).toContainText("60 of 70");
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator(".map-context-bar")).toContainText("70 of 70");
  await page.getByRole("searchbox", { name: "Find map files" }).fill("Note 69");
  await expect(page.locator(".map-file-node")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Clear map search", exact: true })
    .click();
  const source = page.getByRole("button", {
    name: "Select map file Guide v2",
    exact: true,
  });
  await source.click();
  await expect(
    page.getByRole("heading", { name: "File connections", exact: true }),
  ).toBeFocused();
  await page.getByLabel("Filter connection type").selectOption("supports");
  await page.locator(".map-link-option").click();
  await page
    .getByRole("button", { name: "Open source passages", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Temporary evidence failure",
  );
  state.recoverPassages();
  await page
    .getByRole("button", { name: "Retry passages", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Source passage", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".map-source-passages")).toContainText(
    "Original source evidence",
  );
  await page
    .getByRole("button", { name: "Close connection evidence", exact: true })
    .press("Escape");
  await expect(source).toBeFocused();
});

for (const theme of ["Dark", "Light"])
  test(`accessibility audit of overview, filters, history, map and reader in ${theme}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    await audit(page, theme + " overview");
    await page
      .getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      })
      .click();
    await audit(page, theme + " filters");
    await page.getByText("Search options", { exact: true }).click();
    await audit(page, theme + " advanced filters");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      }),
    ).toBeFocused();
    await page
      .getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      })
      .click();
    await page
      .getByRole("group", { name: "Search folder" })
      .getByRole("button", { name: "Research / Guides", exact: true })
      .click();
    await page.getByLabel("Topic group").selectOption("Research review");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await audit(page, theme + " active filters");
    await page
      .getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Review history", exact: true })
      .click();
    await audit(page, theme + " history");
    await page.keyboard.press("Escape");
    for (const view of ["List", "Cards"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await audit(page, theme + " " + view);
    }
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page
      .getByRole("button", { name: "Select map file Guide v2", exact: true })
      .click();
    await audit(page, theme + " map");
    await page
      .getByRole("button", { name: "Read document", exact: true })
      .click();
    await expect(
      page.getByRole("searchbox", { name: "Find in document" }),
    ).toBeVisible();
    await audit(page, theme + " reader");
  });

test("phone reflow, navigation, search recovery and accessible reader controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await expect(
    page.getByRole("button", { name: "Folders — toggle library navigation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Folders — toggle library navigation" })
    .click();
  await page.getByRole("searchbox", { name: "Find a folder" }).fill("Guides");
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Folders — toggle library navigation" })
    .click();
  await openGuide(page);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await audit(page, "390px reader");
  await page
    .getByRole("button", {
      name: /^(Back to library|Close inspector)$/,
      exact: true,
    })
    .click();
  await page.getByLabel("Search your knowledge").fill("missing");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(
    page.getByRole("heading", { name: "No matching files" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to browsing", exact: true })
    .click();
  await expect(page.getByLabel("Folder overview")).toBeVisible();
});

for (const width of [320, 640])
  test(`compact reflow and keyboard dialog navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await fixture(page);
    await page.goto("about:blank");
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Overview", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    const filters = page.getByRole("button", {
      name: /^Search scope and filters(?: \d+)?$/,
      exact: true,
    });
    await filters.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Search filters" }),
    ).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page
          .getByRole("dialog", { name: "Search filters" })
          .evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(filters).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await openGuide(page);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await audit(page, `${width}px reader`);
  });
