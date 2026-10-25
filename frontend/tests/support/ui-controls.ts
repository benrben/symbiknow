import { expect, type Page } from "@playwright/test";

/** Reach each supported layout using the same controls available to people. */
export async function chooseView(page: Page, view: string) {
  if (await page.locator(".app.reader-expanded").count())
    await page.getByRole("button", { name: "Show file list", exact: true }).click();
  const map = page.locator(".app.map-view");
  if (view === "Canvas" || view === "Map") {
    if (!(await map.count()))
      await page
        .getByRole("button", { name: "Explore map", exact: true })
        .first()
        .click();
    if (
      view === "Canvas" &&
      !(await page.getByLabel("Folder canvas", { exact: true }).count())
    )
      await page
        .getByRole("button", { name: "Freeform map", exact: true })
        .click();
  } else {
    if (await map.count())
      await page
        .getByRole("button", { name: "← Back to workspace", exact: true })
        .click();
    await page
      .getByLabel("File layout", { exact: true })
      .selectOption(view === "Cards" ? "grid" : "list");
  }
}
export async function openSearchOptions(page: Page) {
  if (
    !(await page
      .getByRole("dialog", { name: "Search filters", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: /^Search scope and filters(?: \d+)?$/ })
      .click();
}
async function closeSearchOptions(page: Page) {
  if (
    await page
      .getByRole("dialog", { name: "Search filters", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "Done", exact: true }).click();
}
export async function setSearchMode(page: Page, mode: string) {
  await closeSearchOptions(page);
  const resubmit = await page
    .getByRole("heading", { name: "Search results", exact: true })
    .isVisible();
  await setAnswerChecking(page, false);
  await page.getByLabel("Search mode", { exact: true }).selectOption(mode);
  if (resubmit) await page.getByLabel("Search your knowledge").press("Enter");
}
export async function setAnswerChecking(page: Page, checked?: boolean) {
  await closeSearchOptions(page);
  const ask = page
    .getByRole("group", { name: "Search or ask", exact: true })
    .getByRole("button", { name: "Ask", exact: true });
  const enabled = (await ask.getAttribute("aria-pressed")) === "true";
  const target = checked ?? !enabled;
  const resubmit = await page
    .getByRole("heading", { name: "Search results", exact: true })
    .isVisible();
  if (enabled !== target) {
    await page
      .getByRole("group", { name: "Search or ask", exact: true })
      .getByRole("button", { name: target ? "Ask" : "Search", exact: true })
      .click();
    if (resubmit) await page.getByLabel("Search your knowledge").press("Enter");
  }
}
export async function expectSearchMode(page: Page, mode: string) {
  await closeSearchOptions(page);
  if (await page.getByLabel("Search mode", { exact: true }).isVisible())
    await expect(page.getByLabel("Search mode", { exact: true })).toHaveValue(
      mode,
    );
  else {
    expect(mode).toBe("semantic");
    await expect(
      page.getByText("Semantic + checking", { exact: true }),
    ).toBeVisible();
  }
}
export async function expectAnswerChecking(page: Page, checked: boolean) {
  await closeSearchOptions(page);
  await expect(
    page
      .getByRole("group", { name: "Search or ask", exact: true })
      .getByRole("button", { name: "Ask", exact: true }),
  ).toHaveAttribute("aria-pressed", String(checked));
}
export async function splitReader(page: Page) {
  await page.getByRole("button", { name: "Show file list", exact: true }).click();
}
