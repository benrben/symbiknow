import { test, expect } from "./coverage";
import fs from "node:fs/promises";
import path from "node:path";
const shots = path.resolve(
  process.env.SYMBIKNOW_EVIDENCE_DIR
    ? process.env.SYMBIKNOW_EVIDENCE_DIR + "/review-fixes"
    : "../outputs/deep-review-fixes",
);
async function screenshot(page: any, name: string) {
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + ".png") });
}
test("Quick Look belongs to file controls; canvas tools and Space drag retain ownership", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const row = page.getByRole("button", {
    name: "Select storage-decisions",
    exact: true,
  });
  await row.click();
  await row.press("Space");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  const pan = page.getByRole("button", { name: "Pan tool", exact: true });
  await pan.focus();
  await pan.press("Space");
  await expect(pan).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const pane = page.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.mouse.move(bounds!.x + 10, bounds!.y + 10);
  await page.keyboard.down("Space");
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 70, bounds!.y + 45, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(viewport).not.toHaveAttribute("style", before!);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("filtered folder tiles, canvas counts, empty recovery and sidebar global counts agree", async ({
  page,
}) => {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const docs = base.documents.slice(0, 4).map((d: any, i: number) => ({
    ...d,
    folder:
      i < 2
        ? "Engineering / Storage / Decisions"
        : i === 2
          ? "Engineering / Search"
          : "",
    groups: [i === 0 ? "Review A" : "Review B"],
  }));
  const folders = {
    "Engineering / Storage / Decisions": 2,
    "Engineering / Search": 1,
    "": 1,
  };
  await page.route("**/api/library?*", async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const folder = q.get("folder"),
      group = q.get("group");
    const scoped = docs.filter(
      (d: any) =>
        (folder === null ||
          d.folder === folder ||
          (folder && d.folder.startsWith(folder + " / "))) &&
        (!group || d.groups.includes(group)),
    );
    const counts: Record<string, number> = {};
    for (const d of scoped) counts[d.folder] = (counts[d.folder] || 0) + 1;
    const offset = Number(q.get("offset") || 0);
    await route.fulfill({
      json: {
        ...base,
        documents: scoped.slice(offset, offset + 2),
        total: scoped.length,
        has_more: offset + 2 < scoped.length,
        folders,
        scoped_folders: counts,
        groups: ["Review A", "Review B", "Review Empty"],
        library_total: 4,
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.locator(".subfolder-grid")).toContainText("Storage2 files");
  await expect(page.locator(".subfolder-grid")).toContainText("Search1 files");
  await expect(page.locator(".grid-file")).toHaveCount(2);
  await page.getByRole("button", { name: "Search scope and filters" }).click();
  await page.getByRole("menuitem", { name: "Review A", exact: true }).click();
  await expect(page.locator(".subfolder-grid")).toContainText("Storage1 files");
  await expect(page.locator(".subfolder-grid")).not.toContainText("Search");
  await expect(
    page.getByRole("treeitem", { name: "Engineering, 3 files", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(page.locator(".folder-heading")).toContainText("1 file");
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  await page.getByRole("button", { name: "Search scope and filters" }).click();
  await page
    .getByRole("menuitem", { name: "Review Empty", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No files match these filters" }),
  ).toBeVisible();
  await expect(page.locator(".subfolder-grid")).toHaveCount(0);
  await screenshot(page, "filtered-empty");
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.locator(".grid-file")).toHaveCount(2);
  await page.getByRole("button", { name: "Unfiled", exact: true }).click();
  await page.getByRole("button", { name: "Search scope and filters" }).click();
  await page.getByRole("menuitem", { name: "Review A", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No files match these filters" }),
  ).toBeVisible();
});

test("Recent displays Saved descending and every requested sort leaves Recent with truthful table semantics", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  const table = page.getByRole("table", { name: "Files", exact: true });
  await expect(
    table.getByRole("columnheader", { name: "Modified" }),
  ).toHaveAttribute("aria-sort", "descending");
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/library?") &&
      new URL(r.url()).searchParams.get("recent") === "false" &&
      new URL(r.url()).searchParams.get("sort") === "filename",
  );
  await page.getByRole("button", { name: "Sort by Name" }).click();
  const sorted = await (await response).json();
  await expect(
    page.getByRole("heading", { name: "All files", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Name" }),
  ).toHaveAttribute("aria-sort", "ascending");
  const names = sorted.documents.map((d: any) => d.filename);
  expect(names).toEqual([...names].sort());
  await page.getByRole("button", { name: "Sort by Name" }).click();
  await expect(
    table.getByRole("columnheader", { name: "Name" }),
  ).toHaveAttribute("aria-sort", "descending");
  for (const name of ["Type", "Modified"]) {
    await page.getByRole("button", { name: "Sort by " + name }).click();
    await expect(table.getByRole("columnheader", { name })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.getByRole("button", { name: "Sort by " + name }).click();
    await expect(table.getByRole("columnheader", { name })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  }
  await table
    .getByRole("button", { name: "Select storage-decisions", exact: true })
    .click();
  await expect(
    table.getByRole("row").filter({ hasText: "storage-decisions" }),
  ).toHaveAttribute("aria-selected", "true");
  await screenshot(page, "semantic-file-table");
});

test("GFM tables and task lists render in the reader, Quick Look and cards without external resources", async ({
  page,
}) => {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const doc = {
    ...base.documents[0],
    filename: "unicode-table.md",
    mime_type: "text/markdown",
    size: 900,
  };
  const markdown =
    "# Components\n\n| Component | פרטים |\n| --- | --- |\n| Storage | " +
    "Long cell value ".repeat(25) +
    '|\n\n- [x] Exact bytes\n- [ ] Pending item\n\n```python\nprint("שלום")\n```\n\n![blocked](https://example.invalid/tracker.png)\n<script>alert("blocked")</script>';
  await page.route("**/api/library?*", (route) =>
    route.fulfill({
      json: {
        ...base,
        documents: [doc],
        total: 1,
        has_more: false,
        folders: { [doc.folder]: 1 },
        scoped_folders: { [doc.folder]: 1 },
      },
    }),
  );
  await page.route("**/api/document?*", (route) =>
    route.fulfill({
      json: {
        document: doc,
        current_version: doc.version,
        organization: doc,
        evidence: [],
        connections: [],
        versions: [doc],
      },
    }),
  );
  await page.route("**/api/original?*", (route) =>
    route.fulfill({ contentType: "text/markdown", body: markdown }),
  );
  await page.route("**/api/card?*", (route) =>
    route.fulfill({
      json: {
        evidence: [
          { text: markdown, evidence_id: "table:v1:0", provenance: {} },
        ],
      },
    }),
  );
  await page.route("**/api/search", (route) =>
    route.fulfill({
      json: {
        matches: [
          {
            ...doc,
            jev: {
              status: "evaluated",
              label: "partial",
              supporting_chunk_ids: ["table:v1:0"],
            },
            evidence: [
              { text: markdown, evidence_id: "table:v1:0", provenance: {} },
            ],
          },
        ],
        evaluation: { status: "not_evaluated" },
      },
    }),
  );
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) external.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const select = page.getByRole("button", {
    name: "Select unicode-table",
    exact: true,
  });
  await select.press("Enter");
  await expect(page.locator(".prose table")).toBeVisible();
  await expect(page.locator(".prose th").nth(1)).toHaveText("פרטים");
  await expect(
    page.locator(".prose input[type=checkbox]").first(),
  ).toBeChecked();
  await expect(page.locator(".prose pre code")).toContainText('print("שלום")');
  await select.press("Space");
  await expect(page.getByRole("dialog").getByRole("table")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "Jev evaluation" }).check();
  await page.getByLabel("Search your knowledge").fill("Components");
  await page.getByLabel("Search your knowledge").press("Enter");
  await page
    .getByRole("button", { name: "Select unicode-table", exact: true })
    .click();
  await expect(page.locator(".prose table")).toBeVisible();
  await expect(page.locator(".prose td mark")).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Cards" }).click();
  await expect(page.locator(".card-prose table")).toBeVisible();
  expect(external).toEqual([]);
  await screenshot(page, "gfm-table-card");
});

test("historical Details omit current organization and selective reset summaries match choices", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page
    .getByRole("button", { name: "Select storage-decisions", exact: true })
    .press("Enter");
  await page.getByLabel("Preview version").focus();
  await page.getByLabel("Preview version").selectOption("v1");
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(page.getByLabel("Document inspector")).toContainText(
    "Organization not recorded for this historical version",
  );
  await expect(
    page
      .locator(".document-details dt")
      .filter({ hasText: /^(Folder|Groups)$/ }),
  ).toHaveCount(0);
  await expect(page.locator(".why-here")).toHaveCount(0);
  await page.getByLabel("Preview version").selectOption("v3");
  await expect(
    page.locator(".document-details dt").filter({ hasText: /^Folder$/ }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Library actions" }).click();
  await page.getByRole("menuitem", { name: "Reset organization…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("in the entire library");
  await page.getByLabel("Reset scope").selectOption("Engineering");
  await page
    .getByRole("checkbox", { name: "Folders & groups", exact: true })
    .uncheck();
  await expect(dialog).toContainText(
    "Folders, groups and manual placements remain.",
  );
  await expect(dialog).toContainText("in Engineering and its subfolders");
  await expect(dialog).toContainText("incoming links");
  await screenshot(page, "selective-reset");
  await page
    .getByRole("checkbox", { name: "Folders & groups", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Document links", exact: true })
    .uncheck();
  await expect(dialog).toContainText("Document links remain.");
  await page
    .getByRole("checkbox", { name: "Folders & groups", exact: true })
    .uncheck();
  await expect(dialog).toContainText("Choose at least one type");
  await expect(
    page.getByRole("button", { name: "Reset & rebuild", exact: true }),
  ).toBeDisabled();
});

test("mouse-to-keyboard tree focus stays coherent after label and menu clicks", async ({
  page,
}) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Folders", exact: true });
  await tree.getByRole("button", { name: "Engineering", exact: true }).click();
  const engineering = tree.getByRole("treeitem", { name: /^Engineering, / });
  await expect(engineering).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const product = tree.getByRole("treeitem", { name: /^Product, / });
  await expect(product).toBeFocused();
  await product
    .getByRole("button", { name: "Folder actions for Product", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(product).toBeFocused();
});

for (const count of [12, 60, 100])
  test(`canvas ${count}-document overview stays compact and selection opens at reading scale`, async ({
    page,
  }) => {
    const base = await (
      await page.request.get("/api/library?limit=100")
    ).json();
    const docs = Array.from({ length: count }, (_, i) => ({
      ...base.documents[0],
      document_id: "overview-" + i,
      filename: `Document ${i} with a long readable name.md`,
      folder: `Project ${Math.floor(i / 10)} / Subject`,
    }));
    const folders: Record<string, number> = {};
    for (const d of docs) folders[d.folder] = (folders[d.folder] || 0) + 1;
    await page.route("**/api/library?*", (route) =>
      route.fulfill({
        json: {
          ...base,
          documents: docs,
          total: count,
          library_total: count,
          has_more: false,
          folders,
          scoped_folders: folders,
        },
      }),
    );
    await page.route("**/api/card?*", (route) =>
      route.fulfill({
        json: {
          evidence: [
            {
              text: "Focused reading scale with original content.",
              evidence_id: "overview:0",
            },
          ],
        },
      }),
    );
    await page.route("**/api/document?*", (route) =>
      route.fulfill({
        json: {
          document: docs[0],
          current_version: "v3",
          evidence: [],
          connections: [],
          versions: [docs[0]],
        },
      }),
    );
    await page.goto("/");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    // Compact frames now fit twelve documents without requiring an overview.
    // Larger scopes keep bounded previews; actual totals stay on their frames.
    if (count > 12)
      await expect(page.locator(".canvas-overview")).toBeVisible();
    await expect(page.locator(".react-flow__node-document")).toHaveCount(
      count === 12 ? 8 : count === 60 ? 36 : 10,
    );
    await expect(page.locator(".frame-more").first()).toContainText(
      "of 10 files shown",
    );
    const title = page.locator(".canvas-title").first();
    const readable = await title.evaluate((el) => {
      const zoom = Number(
        getComputedStyle(document.querySelector(".canvas")!).getPropertyValue(
          "--canvas-zoom",
        ),
      );
      return parseFloat(getComputedStyle(el).fontSize) * zoom;
    });
    if (await page.locator(".zoom-markers").count()) {
      // At marker scale the group summary carries readable navigation labels.
      const summary = page.getByRole("navigation", {
        name: "Folder groups at low zoom",
      });
      await expect(summary).toBeVisible();
      expect(
        await summary.evaluate((el) =>
          parseFloat(getComputedStyle(el).fontSize),
        ),
      ).toBeGreaterThanOrEqual(12);
    } else expect(readable).toBeGreaterThanOrEqual(10);
    await screenshot(page, `overview-${count}`);
    await title.click();
    await page
      .getByRole("button", { name: "Fit selection", exact: true })
      .click();
    await expect(page.locator(".canvas-overview")).toHaveCount(0);
    await expect(page.locator(".canvas .card-prose").first()).toBeVisible();
  });
