import { test, expect } from "../support/coverage";
import type { Doc, Library } from "../../src/shared/api/client";

const longName = "Annual_customer_renewal_evidence_and_contract_review_notes_for_the_current_financial_year.txt";
const documents: Doc[] = [
  { document_id: "readiness-ready", version: "v1", filename: "Ready.txt", mime_type: "text/plain", status: "indexed", folder: "Reports", groups: [] },
  { document_id: "readiness-queued", version: "v1", filename: "Queued.txt", mime_type: "text/plain", status: "pending", folder: "Reports", groups: [] },
  { document_id: "readiness-indexing", version: "v1", filename: "Indexing.txt", mime_type: "text/plain", status: "indexing", folder: "Reports", groups: [] },
  { document_id: "readiness-unsupported", version: "v1", filename: "Unsupported.pptx", mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", status: "unsupported", folder: "Reports", groups: [] },
  { document_id: "readiness-failed", version: "v1", filename: "Failed.txt", mime_type: "text/plain", status: "failed", folder: "Reports", groups: [] },
  { document_id: "readiness-unreported", version: "v1", filename: "Unreported.txt", mime_type: "text/plain", folder: "Reports", groups: [] },
  { document_id: "readiness-unknown", version: "v1", filename: "Unknown.txt", mime_type: "text/plain", status: "legacy_state", folder: "Reports", groups: [] },
  { document_id: "readiness-long-name", version: "v1", filename: longName, mime_type: "text/plain", status: "indexed", folder: "Reports", groups: [] },
];

test("original and search readiness stay explicit while long names and reader controls fit desktop widths", async ({ page }) => {
  const library: Library = {
    library_id: "readiness-layout-fixture",
    documents,
    total: documents.length,
    library_total: documents.length,
    has_more: false,
    folders: { Reports: documents.length },
    groups: [],
    processing: false,
    max_file_bytes: 10 * 1024 * 1024,
    max_chunk_bytes: 1024 * 1024,
    index_revision: "readiness-index-v1",
    organization_revision: "readiness-organization-v1",
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const action = url.pathname.split("/").at(-1);
    if (action === "library") return route.fulfill({ json: library });
    if (action === "progress") return route.fulfill({ json: {
      index_revision: library.index_revision,
      organization_revision: library.organization_revision,
      processing: false,
    } });
    if (action === "jev-decisions") return route.fulfill({ json: { decisions: [], has_more: false } });
    if (action === "document") {
      const document = documents.find((item) => item.document_id === url.searchParams.get("id"))!;
      return route.fulfill({ json: {
        document,
        current_version: document.version,
        organization: { folder: document.folder, groups: [], organization_status: "evaluated" },
        organization_review: {},
        evidence: [],
        connections: [],
        versions: [document],
      } });
    }
    if (action === "original") return route.fulfill({
      contentType: "text/plain",
      body: "This full-width reader text remains readable while the file navigator is visible.",
    });
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${action}` } });
  });

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");

  const readiness = async (filename: string, label: string) => {
    const row = page.locator(".file-row").filter({ has: page.getByRole("button", { name: `Select ${filename}`, exact: true }) });
    await expect(row.locator(".file-readiness")).toContainText("Original saved");
    await expect(row.locator(".file-readiness")).toContainText(label);
  };
  await readiness("Ready.txt", "Search ready");
  await readiness("Queued.txt", "Search queued");
  await readiness("Indexing.txt", "Indexing");
  await readiness("Unsupported.pptx", "Search unsupported");
  await readiness("Failed.txt", "Indexing failed");
  await readiness("Unreported.txt", "Search status not reported");
  await readiness("Unknown.txt", "Search status unknown");

  for (const width of [1024, 1365, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = page.getByLabel("File layout");
    const importButton = page.getByRole("button", { name: "Import", exact: true });
    await expect(layout).toBeInViewport();
    await expect(importButton).toBeInViewport();
    await layout.selectOption("grid");
    const cardSelect = page.getByRole("button", { name: `Select ${longName}`, exact: true });
    await expect(cardSelect).toHaveAttribute("title", longName);
    await expect(page.locator(".grid-file").filter({ has: cardSelect }).locator(".file-readiness")).toContainText("Original saved");
    const cardLineCount = await cardSelect.locator(".file-description > strong").evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
    });
    expect(cardLineCount).toBeLessThanOrEqual(2);
    await layout.selectOption("list");
    const select = page.getByRole("button", { name: `Select ${longName}`, exact: true });
    await expect(select).toHaveAttribute("title", longName);
    const name = select.locator(".file-description > strong");
    const lineCount = await name.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
    });
    expect(lineCount).toBeLessThanOrEqual(2);

  }

  await page.setViewportSize({ width: 1024, height: 800 });
  const select = page.getByRole("button", { name: `Select ${longName}`, exact: true });
  await select.dblclick();
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("tab", { name: "Document", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: /^(Expand reader|Show file list)$/ })).toBeInViewport();
  await expect(inspector.getByRole("button", { name: /^(Close inspector|Back to library)$/ })).toBeInViewport();
  await expect(inspector.locator(".text-preview")).toContainText("full-width reader text remains readable");
  await expect(page.getByRole("button", { name: `Read ${longName}`, exact: true })).toHaveAttribute("title", longName);
  const textWidth = await inspector.locator(".text-preview").evaluate((element) => element.getBoundingClientRect().width);
  expect(textWidth).toBeGreaterThanOrEqual(320);
});
