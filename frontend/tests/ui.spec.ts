import { test, expect } from "./coverage";
import fs from "node:fs/promises";
import path from "node:path";
const screenshots = path.resolve(
  process.env.SYMBIKNOW_EVIDENCE_DIR
    ? process.env.SYMBIKNOW_EVIDENCE_DIR + "/ui"
    : "../screenshots",
);
test("reference screens, canvas links, history, keyboard and responsive layouts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("7 files", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page
    .getByRole("button", { name: "Select storage-decisions", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: "Keep every version" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await fs.mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: path.join(screenshots, "01-library-canvas-1440.png"),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, "01-library-canvas-1280.png"),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: /retrieval-notes.md → storage-decisions.md/ })
    .click();
  await expect(page.getByText("Source passage", { exact: true })).toBeVisible();
  await expect(page.getByText("Target passage", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Document", exact: true }).click();
  await page
    .getByRole("button", { name: "Library actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Reset organization…",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("Reset scope")).toHaveValue("*");
  await page.screenshot({
    path: path.join(screenshots, "03-reset-confirmation-1440.png"),
  });
  await page
    .getByRole("checkbox", { name: "Folders & groups", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Document links", exact: true })
    .uncheck();
  await expect(
    page.getByRole("button", { name: "Reset & rebuild", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await expect(
    page.getByRole("textbox", { name: "Search your knowledge" }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Search your knowledge" })
    .fill("keep every version");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Search results" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Folder canvas")).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Jev evaluation" }),
  ).not.toBeChecked();
  await page.getByRole("switch", { name: "Jev evaluation" }).click();
  await expect(
    page.getByText("Supports answer", { exact: true }).first(),
  ).toBeVisible();
  await page
    .locator(".results-list .file-row")
    .filter({ hasText: "storage-decisions" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Keep every version" }),
  ).toBeVisible();
  await page.locator(".search-main").evaluate((el) => (el.scrollTop = 0));
  await page
    .getByLabel("Search your knowledge")
    .fill("Each update is saved as a new version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".results-list .file-row").first()).toContainText(
    "storage-decisions",
  );
  await page.locator(".results-list .file-row").first().dblclick();
  await expect(
    page.getByRole("heading", { name: "Keep every version" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "02-search-evidence-1440.png"),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: path.join(screenshots, "02-search-evidence-1280.png"),
  });
  await page.getByRole("switch", { name: "Jev evaluation" }).click();
  await expect(page.getByText("Supports answer", { exact: true })).toHaveCount(
    0,
  );
  for (const mode of ["Semantic", "Keyword", "Hybrid"]) {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/search") &&
        r.request().postDataJSON().mode === mode.toLowerCase(),
    );
    await page.getByLabel("Search mode").selectOption(mode.toLowerCase());
    await response;
  }
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Search results" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByRole("heading", { name: "All files", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select storage-decisions", exact: true })
    .click();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await page.getByRole("button", { name: /v2.*storage-decisions.md/ }).click();
  await expect(
    page.getByRole("heading", { name: "Earlier storage decision" }),
  ).toBeVisible();
  await page.getByLabel("Preview version").selectOption("v1");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download v1", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("storage-decisions.md");
  expect(await fs.readFile((await download.path())!, "utf8")).toContain(
    "Each update is saved as a new version.",
  );
  await page.getByLabel("Preview version").selectOption("v3");
  await page.setViewportSize({ width: 960, height: 800 });
  await expect(page.getByLabel("Document inspector")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "04-inspector-drawer-960.png"),
  });
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Document inspector")).toHaveCount(0);
  await page.setViewportSize({ width: 1102, height: 808 });
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await expect(page.locator(".file-row").first()).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "05-files-760.png") });
  expect(errors).toEqual([]);
});

test("bulk uploads, explicit update, history bytes and unsupported file", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const payload = Buffer.from("Browser upload fixture\nOriginal bytes\n");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles([
    { name: "browser-upload.txt", mimeType: "text/plain", buffer: payload },
    {
      name: "unsupported.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 255, 12]),
    },
  ]);
  await expect(
    page.locator(".file-row").filter({ hasText: "browser-upload" }),
  ).toBeVisible();
  await page
    .locator(".file-row")
    .filter({ hasText: "browser-upload" })
    .dblclick();
  await expect(
    page.getByText("Browser upload fixture", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Document actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Update file…" }).click();
  await page.getByLabel("Update selected file", { exact: true }).setInputFiles({
    name: "browser-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Updated browser fixture\n"),
  });
  await expect(page.getByLabel("Preview version")).toHaveValue("v2");
  await page.getByLabel("Preview version").selectOption("v1");
  await expect(page.locator(".text-preview")).toContainText("Original bytes");
  const ready = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download v1", exact: true }).click();
  const download = await ready;
  expect(await fs.readFile((await download.path())!)).toEqual(payload);
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.locator(".file-row").filter({ hasText: "unsupported" }).dblclick();
  await expect(
    page.getByText("This format has no browser preview.", { exact: false }),
  ).toBeVisible();
});

test("obsolete search responses cannot replace current results", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  let released: () => void = () => {};
  await page.route("**/api/search", async (route) => {
    const data = route.request().postDataJSON();
    if (data.query === "obsolete") {
      await new Promise<void>((r) => (released = r));
      await route.fulfill({
        json: {
          matches: [
            {
              document_id: "obsolete",
              version: "v1",
              filename: "obsolete.txt",
              mime_type: "text/plain",
            },
          ],
          evaluation: { status: "not_requested" },
        },
      });
    } else await route.continue();
  });
  await page.getByLabel("Search your knowledge").fill("obsolete");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.getByText("Finding useful evidence…")).toBeVisible();
  await page.getByLabel("Search your knowledge").fill("keep every version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  released();
  await expect(page.getByText("obsolete", { exact: true })).toHaveCount(0);
});

test("HTML preview is sandboxed and cannot execute scripts or fetch remote assets", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  let external = 0;
  page.on("request", (r) => {
    if (r.url().startsWith("https://example.com")) external++;
  });
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "hostile.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<meta http-equiv="refresh" content="0;url=https://example.com/leak"><iframe src="https://example.com/leak"></iframe><h1>Safe content</h1><script>parent.document.body.innerHTML="ATTACK"</script><img src="https://example.com/leak"><form action="https://example.com"><input></form>',
    ),
  });
  await page.locator(".file-row").filter({ hasText: "hostile" }).dblclick();
  await expect(page.locator("iframe.html-preview")).toHaveAttribute(
    "sandbox",
    "",
  );
  await expect(
    page
      .frameLocator("iframe.html-preview")
      .getByRole("heading", { name: "Safe content" }),
  ).toBeVisible();
  expect(external).toBe(0);
  await expect(
    page.getByRole("heading", { name: "All files", exact: true }),
  ).toBeVisible();
});

test("search failure can retry the same query; Jev outage keeps retrieval usable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const evaluation = page.getByRole("switch", { name: "Jev evaluation" });
  if ((await evaluation.getAttribute("aria-checked")) === "true")
    await evaluation.click();
  await expect(evaluation).toHaveAttribute("aria-checked", "false");
  let fail = true;
  await page.route("**/api/search", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Temporary retrieval failure" },
      });
    } else await route.continue();
  });
  await page.getByLabel("Search your knowledge").fill("keep every version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.getByText("Temporary retrieval failure")).toBeVisible();
  await page.getByRole("button", { name: "Retry search" }).click();
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  await page.unroute("**/api/search");
  await page.route("**/api/search", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.evaluation = { status: "unavailable" };
    body.matches = body.matches.map((d: Record<string, unknown>) => {
      delete d.jev;
      return d;
    });
    await route.fulfill({ json: body });
  });
  await page.getByRole("switch", { name: "Jev evaluation" }).click();
  await expect(
    page.getByText(
      "Answer checking is unavailable. Retry, or turn off Check answers to browse related files.",
    ),
  ).toBeVisible();
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  await expect(page.getByText("Supports answer", { exact: true })).toHaveCount(
    0,
  );
});

test("selective reset uses actual folder count and leaves unchecked grouping intact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library actions" }).click();
  await page.getByRole("menuitem", { name: "Reset organization…" }).click();
  await page.getByLabel("Reset scope").selectOption("Engineering");
  await expect(page.getByLabel("Reset scope")).toContainText(
    "Engineering · 3 files",
  );
  await page
    .getByRole("checkbox", { name: "Folders & groups", exact: true })
    .uncheck();
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/rebuild") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Reset & rebuild", exact: true })
    .click();
  const response = await responsePromise;
  expect(response.request().postDataJSON()).toEqual({
    folder: "Engineering",
    grouping: false,
    links: true,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Jev activity" })).toContainText("Jev");
  await expect
    .poll(
      async () => {
        const r = await page.request.get("/api/rebuild");
        return (await r.json()).status;
      },
      { timeout: 20000 },
    )
    .toMatch(/completed|partial_failure/);
  const library = await (await page.request.get("/api/library")).json();
  expect(library.folders.Engineering).toBe(3);
});

test("dev proxy preserves same-origin uploads and rejects foreign origins", async ({
  page,
  request,
}) => {
  await page.goto("http://127.0.0.1:5174/");
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import", exact: true })
    .first()
    .click();
  await (
    await chooser
  ).setFiles({
    name: "AGENTS.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Dev proxy regression\nThis document was uploaded through Vite.\n",
    ),
  });
  await expect(page.getByText("Local same-origin access required")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("AGENTS.md", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const reply = await request.get("http://127.0.0.1:5174/api/library");
      const library = await reply.json();
      return library.documents.some(
        (d: { filename: string }) => d.filename === "AGENTS.md",
      );
    })
    .toBe(true);
  const blocked = await request.post("http://127.0.0.1:5174/api/upload", {
    headers: { Origin: "http://evil.example", "X-Symbiknow-UI": "1" },
    data: { files: [] },
  });
  expect(blocked.status()).toBe(403);
  await expect
    .poll(async () =>
      page.locator(".react-flow__node-folder").evaluateAll((nodes) => {
        const boxes = nodes.map((node) => node.getBoundingClientRect());
        return boxes.every((a, i) =>
          boxes
            .slice(i + 1)
            .every(
              (b) =>
                a.right <= b.left ||
                b.right <= a.left ||
                a.bottom <= b.top ||
                b.bottom <= a.top,
            ),
        );
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await fs.mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: path.join(screenshots, "06-dev-proxy-upload.png"),
  });
});

test("delete options confirm, cancel, preserve folder documents and purge all document versions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "delete-option.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Delete feature fixture\nOriginal version\n"),
  });
  await page
    .locator(".file-row")
    .filter({ hasText: "delete-option" })
    .dblclick();
  const library = await (await page.request.get("/api/library")).json();
  const doc = library.documents.find(
    (d: { filename: string }) => d.filename === "delete-option.txt",
  );
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Update file…" }).click();
  await page.getByLabel("Update selected file").setInputFiles({
    name: "delete-option.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Delete feature fixture\nSecond version\n"),
  });
  await expect(page.getByLabel("Preview version")).toHaveValue("v2");
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Delete document…" }).click();
  await expect(page.getByRole("dialog")).toContainText("all its versions");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (
      await page.request.get(`/api/download?id=${doc.document_id}&version=v1`)
    ).status(),
  ).toBe(200);
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Delete document…" }).click();
  await page
    .getByRole("button", { name: "Delete document", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".file-row").filter({ hasText: "delete-option" }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.get(`/api/download?id=${doc.document_id}&version=v1`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.get(`/api/download?id=${doc.document_id}&version=v2`)
    ).status(),
  ).toBe(404);
  const before = await (await page.request.get("/api/library")).json();
  const folder = "Product";
  expect(before.folders[folder]).toBeGreaterThan(0);
  const ids = before.documents
    .filter((d: { folder: string }) => d.folder === folder)
    .map((d: { document_id: string }) => d.document_id);
  await page
    .getByRole("button", { name: "Folder actions for " + folder, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Remove folder…" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Original files, version history",
  );
  await page
    .getByRole("button", { name: "Remove folder", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Folder actions for " + folder,
      exact: true,
    }),
  ).toHaveCount(0);
  for (const id of ids) {
    const detail = await (
      await page.request.get(`/api/document?id=${id}`)
    ).json();
    expect(detail.organization.folder).toBe("");
    expect(detail.versions.length).toBeGreaterThan(0);
    expect((await page.request.get(`/api/download?id=${id}`)).status()).toBe(
      200,
    );
  }
});

test("query, verdicts and selection survive Files and Map switches", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("switch", { name: "Jev evaluation" }).click();
  await page.getByLabel("Search your knowledge").fill("keep every version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".results-list .file-row").first()).toBeVisible();
  const names = await page
    .locator(".results-list .file-description > strong")
    .allTextContents();
  await page.locator(".results-list .file-row").first().dblclick();
  const selected = await page.locator(".inspector-heading h2").textContent();
  const verdicts = await page
    .locator(".results-list .judgment")
    .allTextContents();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(page.getByLabel("Folder canvas")).toBeVisible();
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(
    page.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Folder canvas")).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  expect(
    await page
      .locator(".results-list .file-description > strong")
      .allTextContents(),
  ).toEqual(names);
  expect(
    await page.locator(".results-list .judgment").allTextContents(),
  ).toEqual(verdicts);
  await expect(page.locator(".inspector-heading h2")).toHaveText(selected!);
  await expect(page.getByLabel("Search your knowledge")).toHaveValue(
    "keep every version",
  );
});

test("terminal indexing outcomes replace queued upload notices", async ({
  page,
}) => {
  // Pagination pauses library refresh. Notices must still poll their own status.
  await page.route("**/api/library?*", async (route) => {
    const response = await route.fetch();
    const library = await response.json();
    await route.fulfill({ json: { ...library, has_more: true } });
  });
  const polled = new Set<string>();
  await page.route("**/api/document?id=*", async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    if (
      detail.document.filename.startsWith("notice-") &&
      !polled.has(detail.document.document_id)
    ) {
      polled.add(detail.document.document_id);
      detail.organization.status = "pending";
    }
    await route.fulfill({ json: detail });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles([
    {
      name: "notice-empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(""),
    },
    {
      name: "notice-unsupported.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([255, 0]),
    },
  ]);
  await expect(
    page.locator(".transfers > div").filter({ hasText: "notice-empty.txt" }),
  ).toContainText("Empty / no extracted content", { timeout: 15000 });
  await expect(
    page
      .locator(".transfers > div")
      .filter({ hasText: "notice-unsupported.bin" }),
  ).toContainText("Unsupported format", { timeout: 15000 });
  await expect(page.locator(".transfers")).not.toContainText("Indexing queued");
});

test("PDF preview has open and download alternatives without an embedded viewer", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => false }),
  );
  const doc = {
    document_id: "pdf-fixture",
    version: "v1",
    filename: "preview.pdf",
    mime_type: "application/pdf",
    status: "indexed",
    size: 100,
  };
  await page.route("**/api/library?*", async (route) => {
    const response = await route.fetch();
    const library = await response.json();
    await route.fulfill({
      json: { ...library, documents: [doc], total: 1, has_more: false },
    });
  });
  await page.route("**/api/document?id=pdf-fixture*", (route) =>
    route.fulfill({
      json: {
        document: doc,
        current_version: "v1",
        organization: doc,
        evidence: [],
        connections: [],
        versions: [doc],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.locator(".file-row").filter({ hasText: "preview" }).dblclick();
  await expect(
    page.getByText("PDF page preview unavailable.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open original PDF", exact: true }),
  ).toHaveAttribute("href", /original.*version=v1/);
  await expect(
    page.getByRole("link", { name: "Download PDF", exact: true }),
  ).toHaveAttribute("href", /download.*version=v1/);
  await expect(page.locator("iframe.pdf-preview")).toHaveCount(0);
});

test("scoped counts, representative cards, matched snippets and symmetric edge framing", async ({
  page,
}) => {
  const docs = [
    {
      document_id: "card-a",
      version: "v1",
      filename: "neutral-a.txt",
      mime_type: "text/plain",
      folder: "Project / Billing",
      status: "indexed",
    },
    {
      document_id: "card-b",
      version: "v1",
      filename: "neutral-b.txt",
      mime_type: "text/plain",
      folder: "Project / Billing",
      status: "indexed",
    },
  ];
  const forward = {
    source_document_id: "card-a",
    source_version: "v1",
    document_id: "card-b",
    version: "v1",
    relation: "duplicate",
    source_chunk_id: "a",
    target_chunk_id: "b",
    source_filename: "neutral-a.txt",
    target_filename: "neutral-b.txt",
  };
  const reverse = {
    ...forward,
    source_document_id: "card-b",
    document_id: "card-a",
    source_chunk_id: "b",
    target_chunk_id: "a",
    source_filename: "neutral-b.txt",
    target_filename: "neutral-a.txt",
  };
  await page.route("**/api/library?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        documents: docs,
        total: 2,
        has_more: false,
        folders: { "Project / Billing": 2, "Other / Support": 6 },
        scoped_folders: { "Project / Billing": 2 },
      },
    });
  });
  let cardARequests = 0;
  await page.route("**/api/card?*", async (route) => {
    if (route.request().url().includes("id=card-a")) cardARequests++;
    await route.fulfill({
      json: {
        evidence: [
          {
            evidence_id: "body",
            text: "Billing procedures\nCorrect invoice charges with a credit note.",
          },
        ],
      },
    });
  });
  await page.route("**/api/neighborhood?id=card-*", (route) =>
    route.fulfill({ json: { documents: docs, links: [forward, reverse] } }),
  );
  await page.route("**/api/document?id=card-*", (route) =>
    route.fulfill({
      json: {
        document: docs[0],
        current_version: "v1",
        organization: docs[0],
        evidence: [],
        connections: [forward],
        versions: [docs[0]],
      },
    }),
  );
  await page.route("**/api/download?id=card-*", (route) =>
    route.fulfill({
      body: "Original billing document.",
      contentType: "text/plain",
    }),
  );
  await page.route("**/api/search", (route) =>
    route.fulfill({
      json: {
        status: "completed",
        evaluation: { status: "evaluated" },
        matches: [
          {
            ...docs[0],
            evidence: [
              {
                evidence_id: "card-a:v1:t0",
                text: "Library opening passage.",
                basis: "text",
                provenance: {},
              },
              {
                evidence_id: "card-a:v1:t1",
                text: "Refund requests are accepted within fourteen days.",
                basis: "text",
                provenance: {},
              },
            ],
            excerpt: "Refund requests are accepted within fourteen days.",
            jev: {
              status: "evaluated",
              label: "direct",
              supporting_chunk_ids: ["card-a:v1:t1"],
            },
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("2 files", { exact: true })).toBeVisible();
  const cardA = page.getByRole("button", {
    name: "Select neutral-a",
    exact: true,
  });
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  const cardNode = cardA.locator(
    "xpath=ancestor::div[contains(@class, 'canvas-document')]",
  );
  await expect(cardNode).toContainText("Correct invoice charges");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await cardA.click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  // Relationship labels appear on selected edges in the compact design.
  const point = await page
    .locator(".react-flow__edge-interaction")
    .evaluate((el) => {
      const path = el as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(
        path.getScreenCTM()!,
      );
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".link-strip")).toContainText("duplicate");
  expect(
    await page.locator(".react-flow__edge-path").getAttribute("marker-end"),
  ).toBeNull();
  await expect
    .poll(() =>
      page.locator(".canvas").evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        const labels = [
          ...canvas.querySelectorAll(".react-flow__edge-textwrapper"),
        ];
        return (
          labels.length === 1 &&
          labels.every((label) => {
            const box = label.getBoundingClientRect();
            return (
              box.left >= bounds.left &&
              box.right <= bounds.right &&
              box.top >= bounds.top &&
              box.bottom <= bounds.bottom
            );
          })
        );
      }),
    )
    .toBe(true);
  const before = cardARequests;
  await page.getByLabel("Search your knowledge").fill("refund window");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(
    page.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(cardNode).toContainText(
    "Refund requests are accepted within fourteen days",
  );
  await expect(cardNode).not.toContainText("Correct invoice charges");
  expect(cardARequests).toBe(before);
});

for (const view of ["List", "Canvas"] as const) {
  test(`empty Enter clears active search and restores folder in ${view}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: view, exact: true }).click();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Research", exact: true })
      .click();
    const input = page.getByLabel("Search your knowledge");
    await input.fill("keep every version");
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Search results", exact: true }),
    ).toBeVisible();
    await input.fill("");
    await expect(
      page.getByRole("button", { name: "Clear search" }),
    ).toBeVisible();
    await input.press("Enter");
    await expect(
      page.getByRole("button", { name: "Clear search" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Search results", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Clear folder scope" }),
    ).toContainText("Research");
    await expect(
      page.getByRole("button", { name: view, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    if (view === "List") await expect(page.locator(".file-row")).toHaveCount(2);
    else await expect(page.getByLabel("Folder canvas")).toBeVisible();
    await input.fill("keep every version");
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Search results", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await page.getByRole("button", { name: "All files", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Search results", exact: true }),
    ).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Clear folder scope" }),
    ).toHaveCount(0);
  });
}
