import { expect, type Page } from "@playwright/test";

/** Use public controls to reach the preserved freeform canvas regression surface. */
export async function chooseView(page: Page, view: string) {
  if (await page.locator(".app.reader-expanded").count())
    await page.getByRole("button", { name: "Split view", exact: true }).click();
  await page
    .getByRole("button", {
      name: view === "Canvas" ? "Map" : view,
      exact: true,
    })
    .click();
  if (view === "Canvas")
    await page
      .getByRole("button", { name: "Freeform map", exact: true })
      .click();
}
export async function openSearchOptions(page: Page) {
  if (
    !(await page
      .getByRole("dialog", { name: "Search filters", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      })
      .click();
  if (!(await page.getByLabel("Search mode", { exact: true }).isVisible()))
    await page.getByText("Search options", { exact: true }).click();
}
export async function setSearchMode(page: Page, mode: string) {
  await openSearchOptions(page);
  await page.getByLabel("Search mode", { exact: true }).selectOption(mode);
  await page.getByRole("button", { name: "Done", exact: true }).click();
}
export async function setAnswerChecking(page: Page, checked?: boolean) {
  if (await page.getByRole("dialog", { name: "Search filters", exact: true }).isVisible())
    await page.getByRole("button", { name: "Done", exact: true }).click();
  const control = page.getByRole("switch", {
    name: "Check answers (Jev evaluation)",
    exact: true,
  });
  await control.setChecked(checked ?? !(await control.isChecked()));
}
export async function expectSearchMode(page: Page, mode: string) {
  await openSearchOptions(page);
  await expect(page.getByLabel("Search mode", { exact: true })).toHaveValue(
    mode,
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
}
export async function expectAnswerChecking(page: Page, checked: boolean) {
  if (await page.getByRole("dialog", { name: "Search filters", exact: true }).isVisible())
    await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("switch", {
      name: "Check answers (Jev evaluation)",
      exact: true,
    }),
  ).toBeChecked({ checked });
}
export async function splitReader(page: Page) {
  await page.getByRole("button", { name: "Split view", exact: true }).click();
}
