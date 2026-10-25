import { test, expect } from "../support/coverage";
import fs from "node:fs/promises";

test("visited folders render immediately while fresh requests reconcile changes and revisions", async ({ page }, testInfo) => {
  const base = await (await page.request.get("/api/library?limit=60")).json();
  const makeDoc = (name: string, folder: string) => ({ document_id: name, version: "v1", filename: `${name}.txt`,
    mime_type: "text/plain", status: "indexed", size: 80, folder, groups: [] });
  const atlas = makeDoc("Atlas source", "Atlas"), revised = makeDoc("Revised Atlas source", "Atlas");
  const borealis = makeDoc("Borealis source", "Borealis");
  let revision = "folders-1";
  let atlasReads = 0, borealisReads = 0;
  let warmResponseCompleted = false;
  let releaseWarm!: () => void, releaseBorealis!: () => void;
  const warm = new Promise<void>(resolve => { releaseWarm = resolve; });
  const afterRevision = new Promise<void>(resolve => { releaseBorealis = resolve; });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const action = url.pathname.split("/").at(-1)!;
    if (action === "library") {
      const folder = url.searchParams.get("folder");
      if (folder === "Atlas") {
        atlasReads++;
        if (atlasReads === 1) await new Promise(resolve => setTimeout(resolve, 650));
        else if (atlasReads === 2) { await warm; warmResponseCompleted = true; }
      }
      if (folder === "Borealis") {
        borealisReads++;
        if (borealisReads === 1) await new Promise(resolve => setTimeout(resolve, 650));
        else if (borealisReads === 2) await afterRevision;
      }
      const documents = folder === "Atlas" ? [atlasReads > 1 ? revised : atlas]
        : folder === "Borealis" ? [borealis] : [atlas, borealis];
      return route.fulfill({ json: { ...base, index_revision: revision, documents, total: documents.length,
        library_total: 2, has_more: false, next_cursor: null, folders: { Atlas: 1, Borealis: 1 }, groups: [], processing: false } });
    }
    if (action === "progress") return route.fulfill({ json: { library_id: base.library_id,
      index_revision: revision, organization_revision: base.organization_revision, manual_revision: base.manual_revision, processing: false } });
    if (action === "rebuild") return route.fulfill({ json: null });
    if (action === "jev-decisions") return route.fulfill({ json: { decisions: [], has_more: false } });
    return route.continue();
  });
  await page.goto("/");
  await expect(page.locator(".file-row")).toHaveCount(2);
  const coldStart = Date.now();
  await page.getByRole("button", { name: "Atlas 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Atlas source.txt", exact: true })).toBeVisible();
  const coldFolderMilliseconds = Date.now() - coldStart;
  await page.getByRole("button", { name: "Borealis 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Borealis source.txt", exact: true })).toBeVisible();
  const warmStart = Date.now();
  await page.getByRole("button", { name: "Atlas 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Atlas source.txt", exact: true })).toBeVisible();
  const warmFolderMilliseconds = Date.now() - warmStart;
  await expect.poll(() => atlasReads).toBe(2);
  expect(warmResponseCompleted).toBe(false);
  await expect(page.getByRole("button", { name: "Select Borealis source.txt", exact: true })).toHaveCount(0);
  revision = "folders-2";
  releaseWarm();
  await expect(page.getByRole("button", { name: "Select Revised Atlas source.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Atlas source.txt", exact: true })).toHaveCount(0);
  // Observing the new index revision invalidates Borealis's old snapshot too.
  await page.getByRole("button", { name: "Borealis 1", exact: true }).click();
  await expect.poll(() => borealisReads).toBe(2);
  await expect(page.locator(".file-row")).toHaveCount(0);
  releaseBorealis();
  await expect(page.getByRole("button", { name: "Select Borealis source.txt", exact: true })).toBeVisible();
  const report = { fixture: "650ms cold folder responses; warm response held until cached rows visible",
    coldFolderMilliseconds, warmFolderMilliseconds, atlasReads, borealisReads, freshResponseReconciled: true,
    crossRevisionSnapshotInvalidated: true };
  const output = testInfo.outputPath("folder-snapshot-responsiveness.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  await testInfo.attach("folder-snapshot-responsiveness", { path: output, contentType: "application/json" });
  console.log("Isolated folder snapshots:", JSON.stringify(report));
});

test("navigation stays responsive after a pointer sweeps files on a delayed reader", async ({ page }, testInfo) => {
  // A bounded page in a larger library, with one serialized metadata/storage
  // lane. This isolates speculative frontend traffic from real model startup.
  const base = await (await page.request.get("/api/library?limit=60")).json();
  const documents = Array.from({ length: 60 }, (_, index) => ({
    document_id: `responsiveness-${index}`, version: "v1", filename: `File ${String(index).padStart(3, "0")}.txt`,
    mime_type: "text/plain", status: "indexed", size: 80, folder: "Library", groups: [],
  }));
  let tail = Promise.resolve();
  const serialized = (milliseconds: number) => {
    const next = tail.then(() => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    tail = next;
    return next;
  };
  const counts: Record<string, number> = {};
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const action = url.pathname.split("/").at(-1)!;
    counts[action] = (counts[action] || 0) + 1;
    if (action === "library") {
      await serialized(180);
      return route.fulfill({ json: { ...base, documents, total: 1000, library_total: 1000,
        has_more: false, next_cursor: null, folders: { Library: 1000 }, groups: [], processing: false } });
    }
    if (action === "neighborhood") {
      await serialized(700);
      return route.fulfill({ json: { documents: [], links: [] } });
    }
    if (action === "document") {
      await serialized(300);
      const document = documents.find(doc => doc.document_id === url.searchParams.get("id"))!;
      return route.fulfill({ json: { document, current_version: "v1", organization: null,
        evidence: [], connections: [], versions: [document] } });
    }
    if (action === "original") {
      await serialized(80);
      return route.fulfill({ contentType: "text/plain", body: "Source remains readable after browsing." });
    }
    if (action === "progress") return route.fulfill({ json: {
      index_revision: base.index_revision, organization_revision: base.organization_revision, processing: false,
    } });
    if (action === "rebuild") return route.fulfill({ json: null });
    if (action === "jev-decisions") return route.fulfill({ json: { decisions: [], has_more: false } });
    return route.continue();
  });
  const start = Date.now();
  await page.goto("/");
  await expect(page.locator(".file-row")).toHaveCount(60);
  const firstPageMilliseconds = Date.now() - start;
  const rows = page.locator(".file-row");
  for (let index = 0; index < 8; index++) {
    const box = await rows.nth(index).boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + 100, box!.y + box!.height / 2);
    await page.waitForTimeout(25);
  }
  const speculativeSummaries = counts.document || 0;
  const neighborhoodsBeforeMap = counts.neighborhood || 0;
  expect(speculativeSummaries).toBeLessThanOrEqual(1);
  expect(neighborhoodsBeforeMap).toBe(0);
  const clicked = Date.now();
  await page.getByRole("button", { name: "Select File 000.txt", exact: true }).dblclick();
  await expect(page.locator(".inspector .text-preview")).toContainText("Source remains readable after browsing.");
  const clickToSourceMilliseconds = Date.now() - clicked;
  const report = { fixture: "60 rendered files of1000; serialized read lane: library180ms, neighborhood700ms, summary300ms, original80ms",
    firstPageMilliseconds, speculativeSummaries, neighborhoodsBeforeMap, clickToSourceMilliseconds, requestCounts: counts };
  const output = testInfo.outputPath("browse-responsiveness.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  await testInfo.attach("browse-responsiveness", { path: output, contentType: "application/json" });
  console.log("Isolated browse responsiveness:", JSON.stringify(report));
});

test("index publications refresh visible text cards without refetching hidden cards or immutable thumbnails", async ({ page }, testInfo) => {
  const base = await (await page.request.get("/api/library?limit=60")).json();
  const documents = Array.from({ length: 60 }, (_, index) => ({
    document_id: `card-load-${index}`, version: "v1", filename: `Card ${String(index).padStart(3, "0")}.${index ? "txt" : "png"}`,
    mime_type: index ? "text/plain" : "image/png", status: "indexed", size: 80, folder: "", groups: [],
  }));
  let revision = 1;
  const cards = new Map<string, number>();
  let thumbnailPreparations = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const action = url.pathname.split("/").at(-1)!;
    if (action === "library") return route.fulfill({ json: { ...base, documents, total: 1000, library_total: 1000,
      index_revision: `cards-${revision}`, has_more: false, next_cursor: null, folders: {}, groups: [], processing: false } });
    if (action === "card") {
      const id = url.searchParams.get("id")!;
      cards.set(id, (cards.get(id) || 0) + 1);
      return route.fulfill({ json: { evidence: [{ evidence_id: `${id}:v1:t0`, text: `Card source ${id}. Revision ${revision}.`, provenance: {} }] } });
    }
    if (action === "preview-ready") {
      thumbnailPreparations++;
      return route.fulfill({ json: { ready: true } });
    }
    if (action === "thumbnail") return route.fulfill({ contentType: "image/png", body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q9sAAAAASUVORK5CYII=", "base64") });
    if (action === "progress") return route.fulfill({ json: { index_revision: `cards-${revision}`,
      organization_revision: base.organization_revision, processing: false } });
    if (action === "rebuild") return route.fulfill({ json: null });
    if (action === "jev-decisions") return route.fulfill({ json: { decisions: [], has_more: false } });
    return route.continue();
  });
  await page.goto("/");
  await page.getByLabel("File layout").selectOption("grid");
  const firstText = page.locator('[data-document-id="card-load-1"] .content-card');
  await expect(firstText).toContainText("Revision 1");
  await expect(page.locator('[data-document-id="card-load-0"] .content-card img')).toBeVisible();
  const initialPreparations = thumbnailPreparations;
  const refresh = async () => {
    revision++;
    await page.getByRole("button", { name: "Library actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Refresh library", exact: true }).click();
  };
  await refresh();
  await expect(firstText).toContainText("Revision 2");
  expect(thumbnailPreparations).toBe(initialPreparations);
  const hiddenBefore = cards.get("card-load-1")!;
  await page.locator('[data-document-id="card-load-59"]').scrollIntoViewIfNeeded();
  const lastText = page.locator('[data-document-id="card-load-59"] .content-card');
  await expect(lastText).toContainText("Revision 2");
  await refresh();
  await expect(lastText).toContainText("Revision 3");
  expect(cards.get("card-load-1")).toBe(hiddenBefore);
  const report = { sameHeadVisibleTextRevisions: [1, 2, 3], thumbnailPreparations,
    hiddenCardReadsBeforePublication: hiddenBefore, hiddenCardReadsAfterPublication: cards.get("card-load-1"),
    totalCardReads: [...cards.values()].reduce((sum, count) => sum + count, 0), visitedCards: cards.size };
  const output = testInfo.outputPath("card-request-bounds.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  await testInfo.attach("card-request-bounds", { path: output, contentType: "application/json" });
  console.log("Isolated card request bounds:", JSON.stringify(report));
});
