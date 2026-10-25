import { test, expect } from "../support/coverage";
import type { Page } from "@playwright/test";
import type { Doc, Library } from "../../src/shared/api/client";
import fs from "node:fs/promises";

const existingId = "01fcd72b-d680-4666-827b-2efde8024f25";
const importedId = "a1034b0d-9e17-46ac-bd3c-9bd946e295e9";
const existing: Doc = {
  document_id: existingId, version: "v1", filename: "notes.txt",
  mime_type: "text/plain", status: "unsupported", folder: "", groups: [],
};

async function library(page: Page, documents: Doc[] = []) {
  const base: Library = await (await page.request.get("/api/library?limit=60")).json();
  await page.route("**/api/library?*", route => route.fulfill({ json: {
    ...base, documents, total: documents.length, library_total: documents.length,
    has_more: false, next_cursor: null, folders: { "": documents.length }, groups: [],
    processing: false, taxonomy_has_more: false,
  } }));
}

function receipt(filename = "notes.txt", status = "indexed") {
  return { ...existing, document_id: importedId, filename, status, stored: true };
}

test("duplicate warnings offer opening the current file and explicit version guarded updates", async ({ page }) => {
  await library(page, [existing]);
  let head = "v2";
  const freshReads: string[] = [];
  const pinnedReads: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  await page.route("**/api/document?*", route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("id") !== existingId) return route.continue();
    const version = params.get("version");
    if (version) pinnedReads.push(version);
    else freshReads.push(head);
    const document = { ...existing, version: version || head };
    return route.fulfill({ json: {
      document, current_version: head, organization: null,
      evidence: [], connections: [], versions: [document],
    } });
  });
  await page.route("**/api/upload", async route => {
    const item = route.request().postDataJSON().files[0];
    uploads.push(item);
    await route.fulfill({ json: { files: item.document_id
      ? [{ error: "Expected v3, found v4", stored: false }]
      : [{ ...receipt(), warnings: [{ code: "possible_duplicate", document_id: existingId,
        version: "v1", filename: "notes.txt", reason: "same filename" }] }],
    } });
  });
  await page.goto("/");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("new notes"),
  });
  const imports = page.getByRole("region", { name: "File imports" });
  await expect(imports).toContainText("A new copy was saved");
  await expect(imports).toContainText("same filename");
  await expect(imports).toContainText(existingId);
  await expect(imports).toContainText("This imported copy is kept");
  expect(uploads).toHaveLength(1);
  expect(uploads[0].document_id).toBeUndefined();
  await imports.getByRole("button", { name: "Open existing", exact: true }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect.poll(() => pinnedReads).toContain("v2");
  expect(freshReads).toEqual(["v2"]);

  // The duplicate warning and the open reader have older versions than this head.
  head = "v3";
  await imports.getByRole("button", { name: "Update version", exact: true }).click();
  await expect(imports).toContainText("Expected v3, found v4");
  expect(freshReads).toEqual(["v2", "v3"]);
  expect(uploads).toHaveLength(2);
  expect(uploads[1].document_id).toBe(existingId);
  expect(uploads[1].expected_version).toBe("v3");
  expect(uploads[1].request_id).not.toBe(uploads[0].request_id);

  // Retry preserves the conflict guard and logical upload identity for reconciliation.
  await imports.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => uploads.length).toBe(3);
  await expect(imports).toContainText("Expected v3, found v4");
  expect(uploads[2]).toEqual(uploads[1]);
  expect(freshReads).toEqual(["v2", "v3"]);
});

test("format help is available before the picker and unsupported originals keep a dismissible receipt", async ({ page }) => {
  await library(page);
  await page.route("**/api/upload", route => route.fulfill({
    json: { files: [receipt("budget.csv", "unsupported")] },
  }));
  await page.goto("/");
  await page.getByText("Import formats · searchable or stored only", { exact: true }).click();
  const formats = page.locator(".import-formats");
  await expect(formats).toContainText("Searchable after indexing: TXT, Python and shell text, Markdown");
  await expect(formats).toContainText("Stored only: PowerPoint, older Office formats");
  await expect(formats).toContainText("their contents are not searchable");
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await picker).setFiles({
    name: "budget.csv", mimeType: "text/csv", buffer: Buffer.from("name,total\nfixture,12\n"),
  });
  const imports = page.getByRole("region", { name: "File imports" });
  await expect(imports).toContainText("budget.csv");
  await expect(imports).toContainText("Stored · Unsupported format · Download available");
  await imports.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(imports).toHaveCount(0);
});

test("stored pending imports stay visible and change to searchable after a status response", async ({ page }) => {
  await library(page);
  const pending = receipt("queued.txt", "pending");
  let complete!: () => void;
  const statusReady = new Promise<void>(resolve => { complete = resolve; });
  await page.route("**/api/upload", route => route.fulfill({ json: { files: [pending] } }));
  await page.route("**/api/statuses", async route => {
    await statusReady;
    await route.fulfill({ json: { documents: {
      [importedId]: { ...pending, status: "indexed" },
    } } });
  });
  try {
    await page.goto("/");
    await page.getByLabel("Upload files", { exact: true }).setInputFiles({
      name: "queued.txt", mimeType: "text/plain", buffer: Buffer.from("queued text"),
    });
    const imports = page.getByRole("region", { name: "File imports" });
    await expect(imports).toContainText("Stored · Indexing queued");
    complete();
    await expect(imports).toContainText("Stored · Searchable");
    await imports.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(imports).toHaveCount(0);
  } finally { complete(); }
});

test("a failed upload can be retried without changing request identity or bytes", async ({ page }) => {
  await library(page);
  const attempts: Record<string, unknown>[] = [];
  await page.route("**/api/upload", async route => {
    attempts.push(route.request().postDataJSON().files[0]);
    if (attempts.length <= 2) await route.fulfill({ status: 503, json: { error: "Temporary fixture outage" } });
    else await route.fulfill({ json: { files: [receipt("retry.txt")] } });
  });
  await page.goto("/");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry without duplication"),
  });
  const imports = page.getByRole("region", { name: "File imports" });
  await expect(imports).toContainText("Temporary fixture outage");
  expect(attempts).toHaveLength(2);
  await imports.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(imports).toContainText("Stored · Searchable");
  expect(attempts).toHaveLength(3);
  expect(attempts[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
});

test("the pinned original is readable while document details are slow or unavailable", async ({ page }) => {
  const document = { ...existing, status: "indexed", size: 80 };
  await library(page, [document]);
  let release!: () => void;
  const metadataReady = new Promise<void>(resolve => { release = resolve; });
  const originalRequests: string[] = [];
  let preparations = 0;
  await page.route("**/api/document?*", async route => {
    await metadataReady;
    await route.fulfill({ status: 503, json: { error: "Delayed fixture metadata" } });
  });
  await page.route("**/api/original-ready?*", route => {
    preparations++;
    return route.fulfill({ json: { ready: true } });
  });
  await page.route("**/api/original?*", route => {
    originalRequests.push(route.request().url());
    return route.fulfill({ contentType: "text/plain", body: "Pinned source is readable before metadata." });
  });
  try {
    await page.goto("/");
    await page.getByLabel("File layout").selectOption("list");
    await page.getByRole("button", { name: "Select notes.txt", exact: true }).dblclick();
    const reader = page.locator(".inspector");
    await expect(reader).toContainText("Pinned source is readable before metadata.");
    const readsBeforeMetadata = originalRequests.length;
    expect(readsBeforeMetadata).toBeGreaterThan(0);
    for (const url of originalRequests) {
      expect(new URL(url).searchParams.get("id")).toBe(existingId);
      expect(new URL(url).searchParams.get("version")).toBe("v1");
    }
    expect(preparations).toBe(0);
    release();
    await expect(reader).toContainText("Document details unavailable: Delayed fixture metadata");
    await expect(reader).toContainText("Pinned source is readable before metadata.");
    expect(originalRequests).toHaveLength(readsBeforeMetadata);
  } finally { release(); }
});

test("a text preview polls preparation only after original returns 202 and retries the pinned version", async ({ page }) => {
  await library(page, [{ ...existing, status: "indexed", size: 80 }]);
  const originalRequests: string[] = [];
  let prepared = false;
  let jobReads = 0;
  await page.route("**/api/document?*", route => route.fulfill({ json: {
    document: existing, current_version: "v1", organization: null,
    evidence: [], connections: [], versions: [existing],
  } }));
  await page.route("**/api/original?*", route => {
    originalRequests.push(route.request().url());
    return prepared
      ? route.fulfill({ contentType: "text/plain", body: "Prepared original of the pinned version." })
      : route.fulfill({ status: 202, json: { job_id: "fixture-original", status: "queued" } });
  });
  await page.route("**/api/job?id=fixture-original", route => {
    jobReads++;
    prepared = true;
    return route.fulfill({ json: { job_id: "fixture-original", status: "completed", result: { ready: true } } });
  });
  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");
  await page.getByRole("button", { name: "Select notes.txt", exact: true }).dblclick();
  await expect(page.locator(".inspector")).toContainText("Prepared original of the pinned version.");
  expect(jobReads).toBeGreaterThan(0);
  expect(originalRequests.length).toBeGreaterThanOrEqual(2);
  for (const url of originalRequests) {
    expect(new URL(url).searchParams.get("id")).toBe(existingId);
    expect(new URL(url).searchParams.get("version")).toBe("v1");
  }
});

for (const currentLarge of [true, false]) {
  test(`historical text uses actual bytes while metadata is delayed (current ${currentLarge ? "large" : "small"})`, async ({ page }) => {
    const current = { ...existing, version: "v2", size: currentLarge ? 3 * 1024 * 1024 : 20 };
    const older = { ...existing, version: "v1", size: currentLarge ? 20 : 3 * 1024 * 1024 };
    await library(page, [current]);
    let release!: () => void;
    const metadataReady = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/history?*", route => route.fulfill({ json: {
      versions: [current, older], head: "v2", has_more: false,
    } }));
    await page.route("**/api/document?*", async route => {
      const old = new URL(route.request().url()).searchParams.get("version") === "v1";
      if (old) await metadataReady;
      await route.fulfill({ json: { document: old ? older : current, current_version: "v2",
        organization: null, evidence: [], connections: [], versions: [],
      } });
    });
    await page.route("**/api/original?*", route => {
      const doc = new URL(route.request().url()).searchParams.get("version") === "v1" ? older : current;
      return route.fulfill({ contentType: "text/plain", body: doc.size > 2 * 1024 * 1024
        ? "x".repeat(doc.size) : "Small pinned source.",
      });
    });
    try {
      await page.goto("/");
      await page.getByLabel("File layout").selectOption("list");
      await page.getByRole("button", { name: "Select notes.txt", exact: true }).dblclick();
      const reader = page.locator(".inspector");
      await expect(reader).toContainText(currentLarge ? "too large for an inline preview" : "Small pinned source.");
      const versions = page.getByLabel("Preview version", { exact: true });
      await versions.focus();
      await expect(versions.getByRole("option", { name: /^v1/ })).toHaveCount(1);
      await versions.selectOption("v1");
      await expect(reader).toContainText(currentLarge ? "Small pinned source." : "too large for an inline preview");
    } finally { release(); }
  });
}

for (const mime of ["image/png", "application/pdf"]) {
  test(`historical ${mime} previews retain the selected version before metadata arrives`, async ({ page }) => {
    const filename = mime === "image/png" ? "picture.png" : "paper.pdf";
    const current = { ...existing, version: "v2", filename, mime_type: mime, size: 80 * 1024 * 1024 };
    const older = { ...current, version: "v1", size: 100 };
    await library(page, [current]);
    let release!: () => void;
    const metadataReady = new Promise<void>(resolve => { release = resolve; });
    const previewRequests: URL[] = [];
    await page.route("**/api/history?*", route => route.fulfill({ json: {
      versions: [current, older], head: "v2", has_more: false,
    } }));
    await page.route("**/api/document?*", async route => {
      const old = new URL(route.request().url()).searchParams.get("version") === "v1";
      if (old) await metadataReady;
      await route.fulfill({ json: { document: old ? older : current, current_version: "v2",
        organization: null, evidence: [], connections: [], versions: [],
      } });
    });
    await page.route(/\/api\/(?:original-ready|preview-ready)\?/, route => {
      previewRequests.push(new URL(route.request().url()));
      return route.fulfill({ json: { ready: true } });
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q9sAAAAASUVORK5CYII=", "base64");
    await page.route(/\/api\/(?:original|pdf-page)\?/, route => {
      previewRequests.push(new URL(route.request().url()));
      return route.fulfill({ contentType: "image/png", headers: { "X-PDF-Page-Count": "1" }, body: png });
    });
    try {
      await page.goto("/");
      await page.getByLabel("File layout").selectOption("list");
      await page.getByRole("button", { name: `Select ${filename}`, exact: true }).dblclick();
      await expect(page.locator(".inspector .image-preview")).toBeVisible();
      const versions = page.getByLabel("Preview version", { exact: true });
      await versions.focus();
      await expect(versions.getByRole("option", { name: /^v1/ })).toHaveCount(1);
      await versions.selectOption("v1");
      await expect.poll(() => previewRequests.some(url => url.searchParams.get("version") === "v1"
        && /\/(original|pdf-page)$/.test(url.pathname))).toBe(true);
      await expect(page.locator(".inspector .image-preview")).toBeVisible();
      for (const url of previewRequests) {
        expect(url.searchParams.get("id")).toBe(existingId);
        expect(["v1", "v2"]).toContain(url.searchParams.get("version"));
      }
    } finally { release(); }
  });
}

test("isolated reader click to readable original timings", async ({ page }, testInfo) => {
  const samples: { phase: string; milliseconds: number }[] = [];
  for (let sample = 0; sample < 6; sample++) {
    if (sample < 3) {
      await page.goto("/");
      await page.getByLabel("File layout").selectOption("list");
    }
    const row = page.getByRole("button", { name: "Select storage-decisions.md", exact: true });
    await expect(row).toBeVisible();
    await page.evaluate(() => {
      const state = window as unknown as { readerStart: number; readerFirstText?: number };
      state.readerStart = performance.now();
      state.readerFirstText = undefined;
      const observer = new MutationObserver(() => {
        const content = document.querySelector(".inspector:not(.hidden) .prose");
        if (content?.textContent?.includes("Each update is saved as a new version")) {
          state.readerFirstText = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await row.dblclick();
    await expect(page.locator(".inspector:not(.hidden) .prose")).toContainText("Each update is saved as a new version");
    const milliseconds = await page.evaluate(() => {
      const state = window as unknown as { readerStart: number; readerFirstText: number };
      return state.readerFirstText - state.readerStart;
    });
    expect(milliseconds).toBeGreaterThanOrEqual(0);
    samples.push({ phase: sample < 3 ? "first open after page load" : "warm reopen", milliseconds: Math.round(milliseconds) });
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
  }
  const report = { fixture: "Isolated real Markdown originals; deterministic test vectors; Vite development build. No live library.",
    notes: "Includes Playwright double-click dispatch and browser paint observation. First-open samples reload the page; backend/model cold start is excluded.", samples };
  const output = testInfo.outputPath("reader-timings.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  await testInfo.attach("reader-timings", { path: output, contentType: "application/json" });
  console.log("Isolated reader timings:", JSON.stringify(samples));
});
