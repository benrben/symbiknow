import { test, expect } from "@playwright/test";
import { fixture } from "../support/quality-fixture";
import { setSearchMode, setAnswerChecking } from "../support/ui-controls";

test("exact text treats punctuation as data and preserves raw input across Semantic and Ask", async ({
  page,
}) => {
  await fixture(page);
  const requests: Record<string, unknown>[] = [];
  await page.route(/\/api\/(?:search|ask)$/, (route) => {
    requests.push({
      ...route.request().postDataJSON(),
      operation: new URL(route.request().url()).pathname,
    });
    return route.fulfill({
      json: { matches: [], evaluation: { status: "not_requested" } },
    });
  });
  await setSearchMode(page, "exact");
  const literal = "user's file | x; >";
  const escaped = literal.replaceAll("'", "'\\''");
  const input = page.getByLabel("Search your knowledge");
  await input.fill(literal);
  await input.press("Enter");
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests.at(-1)).toMatchObject({
    mode: "grep",
    query: `grep -F -e '${escaped}'`,
  });
  await expect(input).toHaveValue(literal);
  await page.getByLabel("Match case", { exact: true }).uncheck();
  await page.getByLabel("Whole word", { exact: true }).check();
  await input.press("Enter");
  await expect
    .poll(() => requests.at(-1)?.query)
    .toBe(`grep -Fiw -e '${escaped}'`);
  await setSearchMode(page, "semantic");
  await input.press("Enter");
  await expect.poll(() => requests.at(-1)?.mode).toBe("semantic");
  expect(requests.at(-1)?.query).toBe(literal);
  await setAnswerChecking(page, true);
  await input.press("Enter");
  await expect.poll(() => requests.at(-1)?.operation).toBe("/api/ask");
  expect(requests.at(-1)?.query).toBe(literal);
});
