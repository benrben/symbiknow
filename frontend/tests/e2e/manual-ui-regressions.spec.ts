import { test, expect } from "@playwright/test";
import { fixture, openGuide } from "../support/quality-fixture";

test("UI-01/02: search headers reverse their own order and retain saved dates", async ({ page }) => {
  const { documents } = await fixture(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  // The library's active sort deliberately differs from the result sort.
  await page.getByRole("button", { name: "Sort by Type", exact: true }).click();
  await page.getByRole("button", { name: "Sort by Type", exact: true }).click();
  const hits = [
    { ...documents[2], mime_type: "text/plain", created_at: "2025-01-01T00:00:00Z" },
    { ...documents[0], created_at: "2026-03-01T00:00:00Z" },
    { ...documents[1], mime_type: "application/json", created_at: "2024-01-01T00:00:00Z" },
  ];
  await page.route("**/api/search", (route) => route.fulfill({ json: {
    matches: hits, evaluation: { status: "not_requested" }, answer: { status: "not_requested" },
  } }));
  const query = page.getByRole("textbox", { name: "Search your knowledge" });
  await query.fill("keyboard");
  await query.press("Enter");
  const table = page.getByRole("table", { name: "Search results", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  for (const doc of hits) {
    await expect(table.locator(`[data-document-id="${doc.document_id}"] time`)).toHaveAttribute("datetime", doc.created_at);
  }
  const order = () => table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.documentId));
  for (const [name, ids] of [
    ["Name", ["quality-0", "quality-1", "quality-2"]],
    ["Type", ["quality-1", "quality-0", "quality-2"]],
    ["Modified", ["quality-1", "quality-2", "quality-0"]],
  ] as const) {
    const button = table.getByRole("button", { name: `Sort by ${name}`, exact: true });
    const header = table.getByRole("columnheader").filter({
      has: page.getByRole("button", { name: `Sort by ${name}`, exact: true }),
    });
    await button.click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect.poll(order).toEqual(ids);
    await button.click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect.poll(order).toEqual([...ids].reverse());
  }
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("table", { name: "Files", exact: true }).locator("th.type-cell")).toHaveAttribute("aria-sort", "descending");
});

test("UI-03: current and historical Open file return focus on Escape and Close", async ({ page }) => {
  await fixture(page);
  await openGuide(page);
  const opener = page.getByRole("button", { name: "Open file", exact: true });
  for (const version of ["v2", "v1"]) {
    const versionPicker = page.getByLabel("Preview version", { exact: true });
    await versionPicker.focus();
    await expect(versionPicker.locator(`option[value="${version}"]`)).toHaveCount(1);
    await versionPicker.selectOption(version);
    for (const dismiss of ["escape", "close"]) {
      await opener.click();
      const dialog = page.getByRole("dialog", { name: `Guide.md · ${version}`, exact: true });
      await expect(dialog).toBeVisible();
      const close = dialog.getByRole("button", { name: "Close file preview", exact: true });
      await expect(close).toBeFocused();
      if (dismiss === "escape") await close.press("Escape");
      else await close.click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  }
  for (const input of ["Upload files", "Update selected file"]) {
    await expect(page.getByLabel(input, { exact: true })).toHaveAttribute("tabindex", "-1");
  }
});

test("UI-03: Space Quick Look returns focus to the file control", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const file = page.locator('[data-document-id="quality-0"] .file-select');
  await file.focus();
  await file.press("Space");
  const close = page.getByRole("button", { name: "Close file preview", exact: true });
  await expect(close).toBeFocused();
  await close.press("Escape");
  await expect(file).toBeFocused();
  await file.press("Space");
  await close.click();
  await expect(file).toBeFocused();
});

test("UI-03: a removed preview opener has a visible focus fallback", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const file = page.locator('[data-document-id="quality-0"] .file-select');
  await file.focus();
  await file.press("Space");
  const close = page.getByRole("button", { name: "Close file preview", exact: true });
  await expect(close).toBeFocused();
  // Simulate removal during a library refresh without modifying stored files.
  await file.evaluate((element) => element.remove());
  await close.press("Escape");
  await expect(page.getByRole("button", { name: "Open file", exact: true })).toBeFocused();
});

test("UI-04: toolbar controls stay inside the viewport across desktop breakpoints and zoom", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  for (const width of [760, 780, 800, 820, 900, 1024, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const zoom of [1, 1.25]) {
      await page.evaluate((value) => { document.documentElement.style.zoom = String(value); }, zoom);
      const controls = page.locator(".topbar button, .topbar input");
      for (const control of await controls.all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x, `${width}px at ${zoom}x: left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${width}px at ${zoom}x: right edge`).toBeLessThanOrEqual(width + 1);
      }
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Library actions", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Refresh library", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  }
  await page.setViewportSize({ width: 800, height: 600 });
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await resize.focus();
  for (let i = 0; i < 12; i++) await resize.press("ArrowRight");
  const box = await page.getByRole("button", { name: "Library actions", exact: true }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(801);
  await page.screenshot({ path: "test-results/manual-ui-toolbar-800.png" });
});
