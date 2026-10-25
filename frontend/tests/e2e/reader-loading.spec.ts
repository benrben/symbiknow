import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";

const identity = "84e4d181-3ea4-405e-a979-4c667886fe68";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q9sAAAAASUVORK5CYII=",
  "base64",
);

async function readerFixture(
  page: Page,
  type: "pdf" | "png" | "txt" | "csv",
  pending = false,
  multiple = false,
) {
  const base = await (await page.request.get("/api/library?limit=60")).json();
  const document = {
    document_id: identity,
    version: "v1",
    filename: `Reader.${type}`,
    mime_type:
      type === "pdf"
        ? "application/pdf"
        : type === "png"
          ? "image/png"
          : "text/plain",
    status: "indexed",
    size: 80,
    folder: "",
    groups: [],
  };
  const requests: {
    action: string;
    id: string | null;
    milliseconds: number;
    version: string | null;
    page: string | null;
  }[] = [];
  let revision = base.index_revision;
  let start = Date.now(),
    prepared = !pending;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url()),
        action = url.pathname.split("/").at(-1)!;
      if (
        [
          "document",
          "original-ready",
          "preview-ready",
          "original",
          "pdf-page",
          "job",
          "card",
        ].includes(action)
      )
        requests.push({
          action,
          id: url.searchParams.get("id"),
          milliseconds: Date.now() - start,
          version: url.searchParams.get("version"),
          page: url.searchParams.get("page"),
        });
      if (action === "library")
        return route.fulfill({
          json: {
            ...base,
            index_revision: revision,
            documents: multiple
              ? [
                  document,
                  {
                    ...document,
                    document_id: "19493274-a9c1-4d27-8995-d7cb0bea609c",
                    filename: "Second.txt",
                  },
                ]
              : [document],
            total: multiple ? 2 : 1,
            library_total: multiple ? 2 : 1,
            has_more: false,
            next_cursor: null,
            folders: { "": 1 },
            groups: [],
          },
        });
      if (action === "document")
        return route.fulfill({
          json: {
            document,
            current_version: "v1",
            versions: [document],
            evidence: [],
            connections: [],
            organization: null,
          },
        });
      if (action === "card")
        return route.fulfill({
          json: { evidence: [], table: [["Revision"], [String(revision)]] },
        });
      if (action === "original-ready" || action === "preview-ready") {
        await new Promise((resolve) => setTimeout(resolve, 450));
        return route.fulfill({ json: { ready: true } });
      }
      if (action === "original" || action === "pdf-page") {
        if (!prepared)
          return route.fulfill({
            status: 202,
            json: { job_id: "prepared-page", status: "queued" },
          });
        return route.fulfill(
          type === "txt"
            ? {
                contentType: "text/plain",
                body: "Immediately readable pinned text.",
              }
            : {
                contentType: "image/png",
                headers: { "X-PDF-Page-Count": "2" },
                body: png,
              },
        );
      }
      if (action === "job") {
        prepared = true;
        return route.fulfill({
          json: {
            job_id: "prepared-page",
            status: "completed",
            result: { ready: true, version: "v1" },
          },
        });
      }
      if (action === "progress")
        return route.fulfill({
          json: {
            library_id: base.library_id,
            manual_revision: base.manual_revision,
            index_revision: revision,
            organization_revision: base.organization_revision,
            processing: false,
          },
        });
      if (action === "rebuild") return route.fulfill({ json: null });
      if (action === "jev-decisions")
        return route.fulfill({ json: { decisions: [], has_more: false } });
      if (action === "freshness")
        return route.fulfill({
          json: { scan: null, findings: [], recent_scans: [] },
        });
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");
  await expect(
    page.getByRole("button", { name: `Select Reader.${type}`, exact: true }),
  ).toBeVisible();
  return {
    document,
    requests,
    revision: () => String(revision),
    advanceRevision: () => {
      revision += 1;
    },
    start: () => {
      start = Date.now();
    },
    row: page.getByRole("button", {
      name: `Select Reader.${type}`,
      exact: true,
    }),
  };
}

for (const type of ["pdf", "png"] as const)
  test(`cached ${type} bytes display without a preparation round trip`, async ({
    page,
  }, testInfo) => {
    const state = await readerFixture(page, type);
    state.start();
    await state.row.dblclick();
    await expect(
      page.locator(".inspector:not(.hidden) .image-preview"),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".inspector:not(.hidden) .image-preview")
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const output = testInfo.outputPath("fetch-sequence.json");
    await fs.writeFile(output, JSON.stringify(state.requests, null, 2));
    await testInfo.attach("fetch-sequence", {
      path: output,
      contentType: "application/json",
    });
    const artifacts = state.requests.filter((request) =>
      ["preview-ready", "original-ready", "pdf-page", "original"].includes(
        request.action,
      ),
    );
    expect(artifacts[0].action).toBe(type === "pdf" ? "pdf-page" : "original");
    expect(
      artifacts.filter((request) => request.action.endsWith("-ready")),
    ).toEqual([]);
    expect(artifacts.every((request) => request.version === "v1")).toBe(true);
  });

test("cold PDF pages poll the returned preparation job then fetch the same pinned page", async ({
  page,
}, testInfo) => {
  const state = await readerFixture(page, "pdf", true);
  state.start();
  await state.row.dblclick();
  await expect(
    page.locator(".inspector:not(.hidden) .pdf-page-preview"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".inspector:not(.hidden) .pdf-page-preview")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Next PDF page", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "Page 2 of Reader.pdf", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Page 2 of Reader.pdf", exact: true })
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const flow = state.requests.filter((request) =>
    ["preview-ready", "pdf-page", "job"].includes(request.action),
  );
  const polled = flow.findIndex((request) => request.action === "job");
  expect(polled).toBeGreaterThan(0);
  // Development StrictMode can cancel an initial request before replaying its
  // effect. Every pre-poll attempt must still target the same pinned first page.
  expect(
    flow
      .slice(0, polled)
      .map((request) => [request.action, request.version, request.page]),
  ).toEqual(Array.from({ length: polled }, () => ["pdf-page", "v1", "1"]));
  expect(
    flow
      .slice(polled + 1)
      .map((request) => [request.action, request.version, request.page]),
  ).toEqual([
    ["pdf-page", "v1", "1"],
    ["pdf-page", "v1", "2"],
  ]);
  const output = testInfo.outputPath("fetch-sequence.json");
  await fs.writeFile(output, JSON.stringify(state.requests, null, 2));
  await testInfo.attach("fetch-sequence", {
    path: output,
    contentType: "application/json",
  });
});

test("hidden extracted previews defer revision reads until reopened", async ({
  page,
}) => {
  const state = await readerFixture(page, "csv");
  await state.row.dblclick();
  await expect(page.locator(".inspector:not(.hidden) table")).toContainText(
    state.revision(),
  );
  const reads = state.requests.filter(
    (request) => request.action === "card",
  ).length;
  expect(reads).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Back to library", exact: true })
    .click();
  state.advanceRevision();
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/library",
  );
  await page
    .getByRole("button", { name: "Library actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Refresh library", exact: true })
    .click();
  await refreshed;
  await page.waitForTimeout(250);
  expect(
    state.requests.filter((request) => request.action === "card"),
  ).toHaveLength(reads);
  await state.row.dblclick();
  await expect(page.locator(".inspector:not(.hidden) table")).toContainText(
    state.revision(),
  );
  expect(
    state.requests.filter((request) => request.action === "card").length,
  ).toBeGreaterThan(reads);
});

test("a different hidden selection does not start the previous Preview tab's original read", async ({
  page,
}) => {
  const state = await readerFixture(page, "txt", false, true);
  await state.row.dblclick();
  await expect(
    page.locator(".inspector:not(.hidden) .text-preview"),
  ).toContainText("Immediately readable pinned text.");
  await page
    .getByRole("button", { name: "Back to library", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select Second.txt", exact: true })
    .click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  expect(
    state.requests.filter(
      (request) =>
        request.id === "19493274-a9c1-4d27-8995-d7cb0bea609c" &&
        ["original", "document"].includes(request.action),
    ),
  ).toEqual([]);
  const firstReads = state.requests.filter(
    (request) => request.action === "original" && request.id === identity,
  ).length;
  await state.row.click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  expect(
    state.requests.filter(
      (request) => request.action === "original" && request.id === identity,
    ),
  ).toHaveLength(firstReads);
  await page
    .getByRole("button", { name: "Select Second.txt", exact: true })
    .dblclick();
  await expect(
    page.locator(".inspector:not(.hidden) .text-preview"),
  ).toContainText("Immediately readable pinned text.");
  expect(
    state.requests.some(
      (request) =>
        request.id === "19493274-a9c1-4d27-8995-d7cb0bea609c" &&
        request.action === "original" &&
        request.version === "v1",
    ),
  ).toBe(true);
});

test("a hidden selected reader does not fetch originals; ready text survives close and reopen", async ({
  page,
}) => {
  const state = await readerFixture(page, "txt");
  await state.row.click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  expect(
    state.requests.filter((request) => request.action === "original"),
  ).toEqual([]);
  expect(
    state.requests.filter((request) => request.action === "document"),
  ).toEqual([]);
  await state.row.dblclick();
  await expect(
    page.locator(".inspector:not(.hidden) .text-preview"),
  ).toContainText("Immediately readable pinned text.");
  const openedReads = state.requests.filter(
    (request) => request.action === "original",
  ).length;
  expect(openedReads).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Back to library", exact: true })
    .click();
  await state.row.dblclick();
  await expect(
    page.locator(".inspector:not(.hidden) .text-preview"),
  ).toContainText("Immediately readable pinned text.");
  expect(
    state.requests.filter((request) => request.action === "original"),
  ).toHaveLength(openedReads);
});
