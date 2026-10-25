import { expect, test } from "@playwright/test";
import { fixture } from "../support/quality-fixture";

const empty = { scan: null, findings: [], recent_scans: [], has_more: false, next_after: "" };

test("freshness distinguishes loading, read failures and persistent action failures", async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route(url => url.pathname === "/api/freshness", async route => {
    if (route.request().method() === "POST")
      return route.fulfill({ status: 503, json: { error: "Scan could not start. Try again." } });
    reads++;
    await pending;
    return route.fulfill({ json: empty });
  });
  await page.getByRole("button", { name: "Check for outdated documents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Document freshness review" });
  await expect(dialog.getByRole("status")).toHaveText("Loading freshness review…");
  await expect(dialog.getByRole("button", { name: "Scan all documents", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/No scan yet/)).toHaveCount(0);
  release();
  await expect(dialog.getByText(/No scan yet/)).toBeVisible();
  await dialog.getByRole("button", { name: "Scan all documents", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Scan could not start. Try again.");
  const beforePoll = reads;
  await expect.poll(() => reads, { timeout: 7000 }).toBeGreaterThan(beforePoll);
  await expect(dialog.getByRole("alert")).toHaveText("Scan could not start. Try again.");
  await expect(dialog.getByRole("button", { name: "Scan all documents", exact: true })).toBeEnabled();
});

test("freshness results and reference files have independent retry controls", async ({ page }) => {
  await fixture(page);
  let readFails = true;
  await page.route(url => url.pathname === "/api/freshness", route => route.fulfill(
    readFails ? { status: 503, json: { error: "Saved scan unavailable" } } : { json: empty },
  ));
  await page.getByRole("button", { name: "Check for outdated documents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Document freshness review" });
  await expect(dialog.getByRole("alert")).toContainText("Saved scan unavailable");
  await expect(dialog.getByText(/No scan yet/)).toHaveCount(0);
  readFails = false;
  await dialog.getByRole("button", { name: "Retry freshness results" }).click();
  await expect(dialog.getByText(/No scan yet/)).toBeVisible();
  let referenceFails = true;
  await page.route(url => url.pathname === "/api/library", route => route.fulfill(
    referenceFails ? { status: 503, json: { error: "Reference files unavailable" } }
      : { json: { documents: [{ document_id: "reference", filename: "Trusted.txt", version: "v1" }], has_more: false } },
  ));
  await dialog.getByText("Optional reference", { exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reference files unavailable");
  referenceFails = false;
  await dialog.getByRole("button", { name: "Retry reference files" }).click();
  await expect(dialog.getByLabel("Trusted reference document").locator("option")).toHaveCount(2);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("failed reference pagination retries the failed page without skipping files", async ({ page }) => {
  await fixture(page);
  await page.route(url => url.pathname === "/api/freshness", route => route.fulfill({ json: empty }));
  await page.getByRole("button", { name: "Check for outdated documents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Document freshness review" });
  const offsets: number[] = [];
  let fails = true;
  await page.route(url => url.pathname === "/api/library", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 100 && fails) return route.fulfill({ status: 503, json: { error: "Next reference page unavailable" } });
    return route.fulfill({ json: { documents: [{ document_id: `reference-${offset}`, filename: `Reference ${offset}.txt`, version: "v1" }], has_more: offset === 0 } });
  });
  await dialog.getByText("Optional reference", { exact: true }).click();
  await dialog.getByRole("button", { name: "More reference files" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Next reference page unavailable");
  await expect(dialog.getByRole("button", { name: "More reference files" })).toHaveCount(0);
  await expect(dialog.getByLabel("Trusted reference document")).toBeDisabled();
  fails = false;
  await dialog.getByRole("button", { name: "Retry reference files" }).click();
  await expect(dialog.getByLabel("Trusted reference document").locator("option").last()).toHaveText("Reference 100.txt · v1");
  expect(offsets).toEqual([0, 100, 100]);
});
