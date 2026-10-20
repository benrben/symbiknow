import { chooseView, openSearchOptions } from "../support/ui-controls";
import { test, expect } from "../support/coverage";
import fs from "node:fs/promises";
import path from "node:path";
const shots = path.resolve("../artifacts/desktop-redesign");
async function mutate(page: any, action: string, data: any) {
  const r = await page.request.post("/api/" + action, {
    headers: {
      Origin: `http://127.0.0.1:${process.env.SYMBIKNOW_UI_PORT || "8766"}`,
      "X-Symbiknow-UI": "1",
    },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function importNotes(page: any, names: string[]) {
  await page.getByLabel("Upload files", { exact: true }).setInputFiles(
    names.map((name) => ({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# Desktop browsing\n\nOriginal bytes are preserved. Keyboard navigation opens a saved version.\n",
      ),
    })),
  );
  for (const name of names)
    await expect(page.locator(".transfers")).toContainText(name);
  await expect
    .poll(
      async () =>
        (
          await (await page.request.get("/api/library?limit=100")).json()
        ).documents.filter((d: any) => names.includes(d.filename)).length,
    )
    .toBe(names.length);
  // Move/reset tests require completed indexing, not just a saved metadata row.
  await expect
    .poll(
      async () => {
        const library = await (
          await page.request.get("/api/library?limit=100")
        ).json();
        return (
          !library.processing &&
          library.documents.filter(
            (d: any) => names.includes(d.filename) && d.status === "indexed",
          ).length === names.length
        );
      },
      { timeout: 20000 },
    )
    .toBe(true);
  return (
    await (await page.request.get("/api/library?limit=100")).json()
  ).documents.filter((d: any) => names.includes(d.filename));
}
test("multi-selection, loaded Select all, guarded move, ZIP download and Quick Look", async ({
  page,
}) => {
  await page.goto("/");
  await chooseView(page, "List");
  const docs = await importNotes(page, [
    "desktop-bulk-a.md",
    "desktop-bulk-b.md",
  ]);
  await page
    .getByRole("button", {
      name: /^Select desktop\-bulk\-a(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: /^Select desktop\-bulk\-b(?:\.[^.]+)?$/,
      exact: true,
    })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulk-toolbar")).toContainText("2 selected");
  await expect(page.getByLabel("Document inspector")).toHaveCount(0);
  const zip = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected" }).click();
  const download = await zip;
  expect(download.suggestedFilename()).toBe("Symbiknow files.zip");
  expect(
    (await fs.readFile((await download.path())!)).subarray(0, 2).toString(),
  ).toBe("PK");
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  await page.getByLabel("Destination folder").fill("Desktop / Navigation");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const d of docs) {
    const r = await (
      await page.request.get(`/api/document?id=${d.document_id}`)
    ).json();
    expect(r.organization.folder).toBe("Desktop / Navigation");
    expect(r.versions).toHaveLength(1);
    await expect(
      (await page.request.get(`/api/download?id=${d.document_id}`)).body(),
    ).resolves.toEqual(
      Buffer.from(
        "# Desktop browsing\n\nOriginal bytes are preserved. Keyboard navigation opens a saved version.\n",
      ),
    );
  }
  await page
    .getByRole("button", {
      name: /^Select desktop\-bulk\-a(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: /^Select desktop\-bulk\-a(?:\.[^.]+)?$/,
      exact: true,
    })
    .press("Space");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: /^Select desktop\-bulk\-a(?:\.[^.]+)?$/,
      exact: true,
    })
    .focus();
  await page.keyboard.press("Meta+a");
  await expect(page.locator(".bulk-toolbar")).toContainText(
    "Loaded files only",
  );
});

test("folder tree keyboard, subtree rename, move and durable manual assignment", async ({
  page,
}) => {
  await page.goto("/");
  const docs = await importNotes(page, ["desktop-tree.md"]);
  await mutate(page, "move-documents", {
    folder: "Tree / Parent / Child",
    documents: docs.map((d: any) => ({
      document_id: d.document_id,
      expected_version: d.version,
    })),
  });
  await page.reload();
  const tree = page.getByRole("tree", { name: "Folders", exact: true });
  const root = tree.getByRole("treeitem", {
    name: "Tree, 1 files",
    exact: true,
  });
  await root.focus();
  await root.press("ArrowRight");
  await expect(root).toHaveAttribute("aria-expanded", "true");
  await root.press("ArrowRight");
  const parent = tree.getByRole("treeitem", {
    name: "Tree / Parent, 1 files",
    exact: true,
  });
  await expect(parent).toBeFocused();
  await parent.press("ArrowRight");
  await parent.press("ArrowRight");
  const child = tree.getByRole("treeitem", {
    name: "Tree / Parent / Child, 1 files",
    exact: true,
  });
  await expect(child).toBeFocused();
  await child.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Child", exact: true }),
  ).toBeVisible();
  await child.press("ArrowLeft");
  await expect(parent).toBeFocused();
  await page
    .getByRole("button", {
      name: "Folder actions for Tree / Parent",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  await page.getByLabel("Folder name").fill("גישה לעובדים");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Clear folder scope(?:: .+)?$/ }),
  ).toContainText("Tree / גישה לעובדים / Child");
  await page.reload();
  const detail = await (
    await page.request.get(`/api/document?id=${docs[0].document_id}`)
  ).json();
  expect(detail.organization.folder).toBe("Tree / גישה לעובדים / Child");
  expect(detail.versions).toHaveLength(1);
});

test("search scope reruns once; view changes reuse judgments; collapsed matches reveal and restore", async ({
  page,
}) => {
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/search")) calls++;
  });
  await page.goto("/");
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  const expand = page.locator(".canvas").getByRole("button", {
    name: "Expand Research",
    exact: true,
  });
  if (await expand.count()) await expand.click();
  await page
    .locator(".canvas")
    .getByRole("button", { name: "Collapse Research", exact: true })
    .click();
  await page.getByLabel("Search your knowledge").fill("keep every version");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(
    page.getByRole("button", {
      name: /^Select retrieval\-notes(?:\.[^.]+)?$/,
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  await chooseView(page, "List");
  await chooseView(page, "Canvas");
  expect(calls).toBe(1);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Research \d+$/, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Clear folder scope(?:: .+)?$/ }),
  ).toContainText("Research");
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByText("Finding useful evidence…")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page
    .getByRole("button", { name: /^All files \d+$/, exact: true })
    .click();
  await expect(
    page
      .locator(".canvas")
      .getByRole("button", { name: "Expand Research", exact: true }),
  ).toBeVisible();
});

test("canvas drag, arrange undo, viewport and positions survive switching and refresh", async ({
  page,
}) => {
  await page.goto("/");
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  const node = page.locator(".react-flow__node-document").first();
  const id = await node.getAttribute("data-id");
  await node.locator(".canvas-title").click();
  await page
    .getByRole("button", { name: "Fit selection", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator(".canvas")
        .evaluate((el) =>
          Number(getComputedStyle(el).getPropertyValue("--canvas-zoom")),
        ),
    )
    .toBeGreaterThanOrEqual(0.75);
  const before = await node.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );
  const handle = node.locator(".card-handle");
  // Coordinate dragging needs the same layout-stability wait as a locator click.
  await handle.hover({ position: { x: 8, y: 10 } });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 8, box!.y + 10);
  await page.mouse.down();
  await page.mouse.move(box!.x + 20, box!.y + 16, { steps: 3 });
  // Ensure the gesture has actually started before injecting a refresh.
  await expect
    .poll(() => node.evaluate((el) => (el as HTMLElement).style.transform))
    .not.toBe(before);
  await page.clock.install();
  const refreshed = page.waitForResponse((r) =>
    r.url().includes("/api/progress"),
  );
  await page.clock.runFor(4100);
  await refreshed;
  await page.mouse.move(box!.x + 48, box!.y + 30, { steps: 5 });
  await page.mouse.up();
  // Resume animation frames after the controlled background-refresh interval.
  await page.clock.resume();
  await expect
    .poll(() => node.evaluate((el) => (el as HTMLElement).style.transform))
    .not.toBe(before);
  const changed = await page
    .locator(`[data-id="${id}"]`)
    .evaluate((el) => (el as HTMLElement).style.transform);
  expect(changed).not.toBe(before);
  await chooseView(page, "List");
  await chooseView(page, "Canvas");
  await expect
    .poll(() =>
      page
        .locator(`[data-id="${id}"]`)
        .evaluate((el) => (el as HTMLElement).style.transform),
    )
    .toBe(changed);
  await page.reload();
  await expect
    .poll(() =>
      page
        .locator(`[data-id="${id}"]`)
        .evaluate((el) => (el as HTMLElement).style.transform),
    )
    .toBe(changed);
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(`[data-id="${id}"]`)
        .evaluate((el) => (el as HTMLElement).style.transform),
    )
    .toBe(changed);
});

test("desktop panes, grid, long Unicode paths and truthful reset failure", async ({
  page,
}) => {
  await fs.mkdir(shots, { recursive: true });
  await page.goto("/");
  const docs = await importNotes(page, ["API-מסמך-desktop-long.md"]);
  const long = "מסמכים ותהליכי עבודה ארוכים ".repeat(6).trim();
  await mutate(page, "move-documents", {
    folder: "Desktop / " + long,
    documents: [
      { document_id: docs[0].document_id, expected_version: docs[0].version },
    ],
  });
  await page.reload();
  await chooseView(page, "List");
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1102, height: 808 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page
      .getByRole("button", {
        name: /^Select API\-מסמך\-desktop\-long(?:\.[^.]+)?$/,
        exact: true,
      })
      .press("Enter");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await openSearchOptions(page);
    await expect(page.getByLabel("Search mode")).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Import", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(shots, `long-name-${size.width}.png`),
    });
    await page
      .getByRole("button", {
        name: /^(Back to library|Close inspector)$/,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: /^Select API\-מסמך\-desktop\-long(?:\.[^.]+)?$/,
        exact: true,
      }),
    ).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebarBefore = Number(
    await page.getByLabel("Resize sidebar").getAttribute("aria-valuenow"),
  );
  await page.getByLabel("Resize sidebar").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Resize sidebar")).toHaveAttribute(
    "aria-valuenow",
    String(sidebarBefore + 10),
  );
  await page.reload();
  await expect(page.getByLabel("Resize sidebar")).toHaveAttribute(
    "aria-valuenow",
    String(sidebarBefore + 10),
  );
  await page.route("**/api/rebuild", (route) =>
    route.fulfill({
      json: {
        request_id: "reset-ui-fixture",
        status: "partial_failure",
        phase: "complete",
        total: 3,
        completed: 1,
        skipped: 1,
        failed: 1,
        grouping: true,
        links: true,
        details: [
          {
            document_id: "failed",
            filename: "failed.md",
            outcome: "failed",
            reason: "Jev unavailable",
          },
        ],
        failures: { failed: "Jev unavailable" },
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Jev activity" }),
  ).toContainText("1 reviewed · 1 skipped · 1 failed");
  await page.getByText("View files needing attention", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Jev activity" }),
  ).toContainText("failed.md · Jev unavailable");
  await page.screenshot({ path: path.join(shots, "reset-failure.png") });
});

test("background refresh never hides measured cards or clears their content", async ({
  page,
}) => {
  let statusRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/rebuild") && r.method() === "GET")
      statusRequests++;
  });
  await page.goto("/");
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.locator(".canvas-title").first().click();
  await page
    .getByRole("button", { name: "Fit selection", exact: true })
    .click();
  await expect(page.locator(".canvas .card-prose").first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).canvasBlinks = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (
          record.type === "attributes" &&
          el.classList?.contains("react-flow__node-document") &&
          el.style.visibility === "hidden"
        )
          (window as any).canvasBlinks.push("hidden");
      }
    });
    observer.observe(document.querySelector(".canvas")!, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  });
  // Advance three application polling cycles; allow network and React to settle between them.
  await page.clock.install();
  for (let i = 0; i < 3; i++) {
    const response = page.waitForResponse((r) =>
      r.url().includes("/api/progress"),
    );
    await page.clock.runFor(4100);
    await response;
    await expect(page.locator(".canvas .card-prose").first()).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).canvasBlinks)).toEqual([]);
  expect(statusRequests).toBeLessThanOrEqual(5);
});

test("subtree reset preserves sibling canvas positions and originals", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  const docs = await importNotes(page, [
    "layout-affected.md",
    "layout-sibling.md",
  ]);
  for (const [i, folder] of ["Layout / Affected", "Sibling / Notes"].entries())
    await mutate(page, "move-documents", {
      folder,
      documents: [
        { document_id: docs[i].document_id, expected_version: docs[i].version },
      ],
    });
  await page.reload();
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  const lib = await (await page.request.get("/api/library")).json();
  const key = `symbiknow.v2.${lib.library_id}.canvas:*`;
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) || "{}").positions?.[
            "folder:Sibling"
          ],
        key,
      ),
    )
    .toBeTruthy();
  const before = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  await mutate(page, "rebuild", {
    folder: "Layout",
    grouping: true,
    links: true,
  });
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/rebuild")).json()).status,
      { timeout: 20000 },
    )
    .toMatch(/completed|partial_failure/);
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) || "{}").positions?.[
            "folder:Sibling"
          ],
        key,
      ),
    )
    .toEqual(before.positions["folder:Sibling"]);
  const after = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  expect(after.positions[docs[1].document_id]).toEqual(
    before.positions[docs[1].document_id],
  );
  for (const doc of docs) {
    const detail = await (
      await page.request.get(`/api/document?id=${doc.document_id}`)
    ).json();
    expect(detail.versions).toHaveLength(1);
    await expect(
      (await page.request.get(`/api/download?id=${doc.document_id}`)).body(),
    ).resolves.toEqual(
      Buffer.from(
        "# Desktop browsing\n\nOriginal bytes are preserved. Keyboard navigation opens a saved version.\n",
      ),
    );
  }
});

test("changed folder parents and growing frames repair positions without overlaps", async ({
  page,
}) => {
  let changed = false;
  const base = (
    await (await page.request.get("/api/library?limit=100")).json()
  ).documents.slice(0, 4);
  const docs = base.map((d: any, i: number) => ({
    ...d,
    folder: i < 2 ? "Position A" : "Position B",
  }));
  await page.route("**/api/library?*", async (route) => {
    const r = await route.fetch();
    const original = await r.json();
    const current = docs.map((d: any, i: number) =>
      changed && i === 0 ? { ...d, folder: "Position B" } : d,
    );
    await route.fulfill({
      json: {
        ...original,
        documents: current,
        total: 4,
        has_more: false,
        folders: changed
          ? { "Position A": 1, "Position B": 3 }
          : { "Position A": 2, "Position B": 2 },
      },
    });
  });
  await page.goto("/");
  await chooseView(page, "Canvas");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(4);
  const lib = await (await page.request.get("/api/library")).json();
  const key = `symbiknow.v2.${lib.library_id}.canvas:*`;
  await page.evaluate((key) => {
    const layout = JSON.parse(localStorage.getItem(key)!);
    layout.positions["folder:Position B"] = { x: 100, y: 40 };
    localStorage.setItem(key, JSON.stringify(layout));
  }, key);
  changed = true;
  await page.reload();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".react-flow__node-folder").evaluateAll((nodes) => {
        const boxes = nodes.map((n) => n.getBoundingClientRect());
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
  await expect
    .poll(() =>
      page.locator(".react-flow__node-document").evaluateAll((nodes) => {
        const boxes = nodes.map((n) => n.getBoundingClientRect());
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
  const state = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  expect(state.folderById[docs[0].document_id]).toBe("Position B");
  expect(state.positions[docs[0].document_id]).not.toEqual(
    state.positions[docs[2].document_id],
  );
});
