import { test, expect } from "@playwright/test";
import { fixture, openGuide } from "../support/quality-fixture";
import { chooseView } from "../support/ui-controls";

for (const width of [320, 390, 768, 1440]) {
  test(`reader and library panels remain usable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = await fixture(page);
    const capture = async (name: string) => {
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    };
    await chooseView(page, "List");
    await capture("list");
    const navigation = page.getByRole("button", {
      name: "Folders — toggle library navigation",
    });
    if (await navigation.isVisible()) {
      await navigation.click();
      await capture("navigation");
      await page.keyboard.press("Escape");
      await expect(navigation).toBeFocused();
    }
    await chooseView(page, "Cards");
    await page.locator(".file-grid .file-row").first().scrollIntoViewIfNeeded();
    await expect(
      page.locator(".file-grid .file-row").first().locator(".card-prose"),
    ).toContainText("Original source evidence");
    const status = page.locator(".file-grid .file-row").first().locator(".file-readiness-meta");
    expect(await status.evaluate(el => {
      const box = el.getBoundingClientRect();
      const row = el.closest(".file-row")!.getBoundingClientRect();
      return box.left >= row.left && box.right <= row.right && box.top >= row.top && box.bottom <= row.bottom;
    })).toBe(true);
    await capture("cards");
    await chooseView(page, "List");
    await openGuide(page);
    await capture("reader");
    await page
      .getByRole("button", { name: "Document actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    const move = page.getByRole("dialog", {
      name: "Move to folder",
      exact: true,
    });
    await expect(move.getByLabel("Destination folder")).toBeFocused();
    await capture("move-dialog");
    const moveError = "Folder_service_unavailable_" + "x".repeat(160);
    await page.route("**/api/move-documents", (route) =>
      route.fulfill({ status: 503, json: { error: moveError } }),
    );
    await move.getByLabel("Destination folder").fill("Research / Target");
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(move.getByRole("alert")).toContainText(moveError);
    await capture("move-error");
    expect(
      await move.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await expect(move).toBeHidden();
    await page
      .getByRole("button", { name: "Back to library", exact: true })
      .click();

    await page.route("**/api/taxonomy?**", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              dimension: "projects",
              id: "long-project",
              name: "Project with a long descriptive title for renewal evidence and current policy",
              count: 1,
            },
          ],
          has_more: false,
        },
      }),
    );
    await page.route("**/api/catalog?**", (route) =>
      route.fulfill({
        json: {
          documents: [
            {
              ...state.documents[0],
              filename:
                "An_extremely_long_original_filename_without_spaces_that_must_remain_readable_and_downloadable_for_everyone.md",
              indexing_status: "indexed",
              searchable: true,
              project: {
                id: "long-project",
                name: "Project with a long descriptive title for renewal evidence and current policy",
              },
              topics: ["A long retained topic name"],
            },
          ],
          total_originals: 70,
          has_more: false,
        },
      }),
    );
    await page
      .getByRole("button", { name: "Library actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Browse all originals", exact: true })
      .click();
    const inventory = page.getByRole("dialog", {
      name: "Browse all originals",
      exact: true,
    });
    await expect(inventory.locator(".inventory-open")).toBeVisible();
    await capture("inventory");
    const close = inventory.getByRole("button", {
      name: "Close original inventory",
      exact: true,
    });
    await close.click({ trial: true });
    await page.keyboard.press("Escape");
    await expect(inventory).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test("reader indexing errors remain actionable and preserve the pinned file", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const state = await fixture(page);
  const doc = state.documents[0];
  let attempts = 0;
  await page.route("**/api/document?**", (route) =>
    route.fulfill({
      json: {
        document: doc,
        current_version: "v2",
        organization: { ...doc, status: "failed" },
        organization_review: {},
        evidence: [],
        connections: [],
        versions: [doc],
      },
    }),
  );
  await page.route("**/api/retry-index", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      document_id: doc.document_id,
      expected_version: "v2",
    });
    attempts++;
    return route.fulfill(
      attempts === 1
        ? {
            status: 503,
            json: {
              error: "Index worker temporarily unavailable. Please retry.",
            },
          }
        : { json: { status: "queued" } },
    );
  });
  await openGuide(page);
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  const retry = page.getByRole("button", {
    name: "Retry indexing",
    exact: true,
  });
  await retry.click();
  await page.screenshot({ path: testInfo.outputPath("index-error.png") });
  await expect(page.getByRole("alert")).toContainText(
    "Index worker temporarily unavailable",
  );
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  let historyAttempts = 0;
  await page.route("**/api/organization-history?**", (route) => {
    historyAttempts++;
    return route.fulfill(
      historyAttempts === 1
        ? {
            status: 503,
            json: { error: "History is temporarily unavailable." },
          }
        : {
            json: {
              entries: [
                {
                  id: "saved-move",
                  action: "Folder corrected",
                  version: "v2",
                  reason:
                    "Reviewed the original and moved it to the retained research folder.",
                  value: "Research / Guides",
                  actor: "human",
                  timestamp: "2026-10-23T09:00:00Z",
                },
              ],
              has_more: false,
            },
          },
    );
  });
  await page
    .getByText("Organization and connection history", { exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "History is temporarily unavailable",
  );
  await page
    .getByRole("button", { name: "Reload history", exact: true })
    .click();
  await expect(page.locator(".organization-history")).toContainText(
    "Folder corrected",
  );
  await page.locator(".organization-history").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("organization-history.png"),
  });
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(page.locator(".version-row")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("versions.png") });
});
