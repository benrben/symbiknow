import { test, expect } from "../support/coverage";
import type { Doc, Library } from "../../src/shared/api/client";

const file: Doc = {
  document_id: "audit-clarity-file",
  version: "v3",
  filename: "Unsupported original.pptx",
  mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  status: "unsupported",
  folder: "Field Notes",
  groups: ["Renewals"],
};
const library: Library = {
  library_id: "audit-clarity-fixture",
  documents: [file],
  total: 1,
  library_total: 4,
  has_more: false,
  folders: { "Field Notes": 1, Policies: 1 },
  groups: ["Renewals"],
  processing: false,
  max_file_bytes: 10 * 1024 * 1024,
  max_chunk_bytes: 1024 * 1024,
  index_revision: "audit-clarity-index-v1",
  organization_revision: "audit-clarity-organization-v1",
};

const taxonomy = {
  items: [
    { dimension: "projects", id: "project-alpha", name: "Project Alpha", count: 1 },
    { dimension: "folders", id: "Field Notes", name: "Field Notes", count: 1 },
    { dimension: "topics", id: "Renewals", name: "Renewals", count: 1 },
    { dimension: "statuses", id: "unsupported", name: "Search unsupported", count: 1 },
  ],
  has_more: false,
};

async function installBase(page: import("@playwright/test").Page) {
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
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${action}` } });
  });
}

test("search counts stay scoped and Show all keeps folder and topic", async ({ page }) => {
  await installBase(page);
  const libraryRequests: URLSearchParams[] = [];
  const searchRequests: Record<string, unknown>[] = [];
  await page.route("**/api/library?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    libraryRequests.push(params);
    return route.fulfill({ json: { ...library, total: params.get("folder") === "Policies" && params.get("group") === "Renewals" ? 2 : 4 } });
  });
  await page.route("**/api/search", async (route) => {
    searchRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { matches: [], evaluation: { status: "not_requested" } } });
  });

  await page.goto("/");
  await page.getByLabel("Search scope and filters").click();
  await page.getByRole("button", { name: "Policies", exact: true }).click();
  await page.getByLabel("Topic group").selectOption("Renewals");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const input = page.getByLabel("Search your knowledge");
  await input.fill("renewal approval");
  await input.press("Enter");
  await expect.poll(() => searchRequests.length).toBeGreaterThan(0);
  expect(searchRequests.at(-1)).toMatchObject({ query: "renewal approval", folder: "Policies", group: "Renewals" });
  await expect(page.locator(".search-inventory-context")).toContainText("Current search request: renewal approval");
  const allInScope = page.getByRole("button", { name: "Show all 2 files in this scope" });
  await expect(allInScope).toBeVisible();
  await allInScope.click();
  expect(libraryRequests.at(-1)?.get("folder")).toBe("Policies");
  expect(libraryRequests.at(-1)?.get("group")).toBe("Renewals");
  await expect(page.getByLabel("Search your knowledge")).toHaveValue("");
  await expect(page.locator(".search-inventory-context")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Policies", exact: true })).toBeVisible();
  await expect(page.getByText("Showing 1 of 2 files", { exact: true })).toBeVisible();
});

test("original inventory filters independently and opens an unsupported saved file", async ({ page }) => {
  await installBase(page);
  const catalogRequests: URLSearchParams[] = [];
  await page.route("**/api/taxonomy?**", (route) => route.fulfill({ json: taxonomy }));
  await page.route("**/api/catalog?**", (route) => {
    catalogRequests.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: {
      documents: [{
        ...file,
        indexing_status: "unsupported",
        searchable: false,
        project: { id: "project-alpha", name: "Project Alpha" },
        topics: ["Renewals"],
      }],
      total_originals: 4,
      has_more: false,
    } });
  });
  await page.route("**/api/document?**", (route) => route.fulfill({ json: {
    document: file,
    current_version: file.version,
    organization: { folder: file.folder, groups: file.groups, organization_status: "not_evaluated" },
    organization_review: {},
    evidence: [],
    connections: [],
    versions: [file],
  } }));
  await page.route("**/api/original?**", (route) => route.fulfill({ contentType: "text/plain", body: "Saved unsupported original bytes are available." }));

  await page.goto("/");
  await page.getByLabel("Library actions").click();
  await page.getByRole("menuitem", { name: "Browse all originals" }).click();
  const inventory = page.getByRole("dialog", { name: "Browse all originals" });
  await expect(inventory.getByRole("status")).toContainText("4 originals saved in the library");
  const filters: Array<[string, string]> = [
    ["Inventory project", "project-alpha"],
    ["Inventory folder", "Field Notes"],
    ["Inventory topic", "Renewals"],
    ["Inventory status", "unsupported"],
  ];
  for (const [label, value] of filters) {
    const before = catalogRequests.length;
    await inventory.getByLabel(label).selectOption(value);
    await expect.poll(() => catalogRequests.length).toBeGreaterThan(before);
    const latest = catalogRequests.at(-1)!;
    for (const [expectedLabel, expectedValue] of filters.slice(0, filters.findIndex(([name]) => name === label) + 1)) {
      const key = expectedLabel.replace("Inventory ", "");
      expect(latest.get(key)).toBe(expectedValue);
    }
  }
  const result = inventory.locator(".inventory-open");
  await expect(result).toContainText("Unsupported format");
  await expect(result).toHaveAttribute("title", file.filename);
  await result.click();
  await expect(inventory).toBeHidden();
  const inspector = page.locator(".inspector");
  await expect(inspector).toContainText("This format has no browser preview.");
  await expect(inspector).toContainText("Your original file is stored and available to download.");
  await expect(inspector.getByRole("link", { name: "Download v3" })).toBeVisible();
});

test("history and connection provenance say when dates were not recorded", async ({ page }) => {
  await installBase(page);
  const source: Doc = { ...file, document_id: "audit-source", filename: "Audit source.txt", mime_type: "text/plain", status: "indexed" };
  const target: Doc = { ...file, document_id: "audit-target", filename: "Audit target.txt", mime_type: "text/plain", status: "indexed" };
  const link = {
    document_id: target.document_id,
    version: target.version,
    source_version: source.version,
    source_document_id: source.document_id,
    source_filename: source.filename,
    target_filename: target.filename,
    relation: "supports",
    source_chunk_id: "audit-source-claim",
    target_chunk_id: "audit-target-claim",
  };
  await page.route("**/api/library?**", (route) => route.fulfill({ json: { ...library, documents: [source, target], total: 2, library_total: 2 } }));
  await page.route("**/api/document?**", (route) => {
    const doc = new URL(route.request().url()).searchParams.get("id") === target.document_id ? target : source;
    return route.fulfill({ json: {
      document: doc,
      current_version: doc.version,
      organization: { folder: doc.folder, groups: [], organization_status: "evaluated" },
      organization_review: {},
      evidence: [],
      connections: doc.document_id === source.document_id ? [link] : [],
      versions: [doc],
    } });
  });
  await page.route("**/api/organization-history?**", (route) => route.fulfill({ json: {
    entries: [{ id: "legacy-correction", action: "Folder corrected", reason: "Older saved correction." }],
    has_more: false,
  } }));
  await page.route("**/api/link?**", (route) => route.fulfill({ json: { source: [], target: [] } }));

  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");
  await page.getByRole("button", { name: `Select ${source.filename}`, exact: true }).dblclick();
  const inspector = page.locator(".inspector");
  await inspector.getByRole("tab", { name: "Details", exact: true }).click();
  const history = inspector.locator("details.organization-history");
  await history.locator("summary").click();
  await expect(history).toContainText("Reviewer not recorded");
  await expect(history).toContainText("Date not recorded");
  await expect(history).toContainText("Older saved correction.");

  await inspector.getByRole("tab", { name: "Connections", exact: true }).click();
  await inspector.getByRole("button", { name: /Audit source\.txt.*Audit target\.txt/ }).click();
  const provenance = inspector.getByRole("region", { name: "Connection origin and reasoning" });
  await expect(provenance).toContainText("Origin");
  await expect(provenance).toContainText("Review date");
  await expect(provenance).toContainText("Not recorded");
  await expect(provenance).not.toContainText(new Date().getFullYear().toString());
});
