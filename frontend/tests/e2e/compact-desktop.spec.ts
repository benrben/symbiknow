import {
  splitReader,
  chooseView,
  setAnswerChecking,
  expectSearchMode,
} from "../support/ui-controls";
import { test, expect } from "../support/coverage";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

const out = path.resolve("../artifacts/compact-desktop-design/screenshots");
async function capture(page: Page, name: string) {
  await fs.mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name + ".png") });
}
async function fixture(page: Page) {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const docs = Array.from({ length: 96 }, (_, i) => ({
    ...base.documents[0],
    document_id: "compact-" + i,
    version: "v2",
    filename:
      i === 0
        ? "Reset and recovery.md"
        : i === 1
          ? "Version history.md"
          : i === 17
            ? "A very long filename describing storage integrity and historical version preservation across deeply nested project folders.md"
            : `Storage policy ${String(i).padStart(3, "0")}.md`,
    mime_type: "text/markdown",
    size: 1200,
    status: "indexed",
    organization_status: "evaluated",
    folder:
      "Symbiknow / Storage / " +
      (i < 18
        ? "Recovery"
        : ["Versioning", "Recovery", "Integrity", "Decisions"][i % 4]),
    groups: ["Reference"],
    created_at: `2026-10-${String(1 + (i % 12)).padStart(2, "0")}T09:00:00Z`,
  }));
  const folders: Record<string, number> = {};
  docs.forEach((d) => (folders[d.folder] = (folders[d.folder] || 0) + 1));
  const passage = (d: any, version = "v2") => ({
    evidence_id: `${d.document_id}:${version}:t0`,
    text: "Reset preserves original files and historical versions. Each update is saved independently in OCFL.",
    basis: "text",
    provenance: { headings: ["Storage policy"] },
  });
  const link = {
    source_document_id: docs[0].document_id,
    document_id: docs[1].document_id,
    source_version: "v2",
    version: "v2",
    source_filename: docs[0].filename,
    target_filename: docs[1].filename,
    relation: "supports",
    source_chunk_id: passage(docs[0]).evidence_id,
    target_chunk_id: passage(docs[1]).evidence_id,
  };
  const libraryRequests: string[] = [],
    searches: any[] = [];
  let organizationState: Record<string, unknown> = {};
  let indexRevision = "compact-static";
  await page.route("**/api/progress", (route) =>
    route.fulfill({
      json: {
        index_revision: indexRevision,
        organization_revision: "compact-static",
        processing: false,
        ...organizationState,
      },
    }),
  );
  await page.route("**/api/library?*", (route) => {
    libraryRequests.push(route.request().url());
    const q = new URL(route.request().url()).searchParams,
      scope = q.get("folder"),
      offset = Number(q.get("cursor") || 0);
    let scoped = docs.filter(
      (d) =>
        scope === null ||
        d.folder === scope ||
        (!!scope && d.folder.startsWith(scope + " / ")),
    );
    const order =
      q.get("sort") === "date"
        ? "created_at"
        : q.get("sort") === "type"
          ? "mime_type"
          : "filename";
    scoped = [...scoped].sort(
      (a: any, b: any) =>
        String(a[order]).localeCompare(String(b[order])) *
        (q.get("descending") === "true" ? -1 : 1),
    );
    const counts: Record<string, number> = {};
    scoped.forEach((d) => (counts[d.folder] = (counts[d.folder] || 0) + 1));
    return route.fulfill({
      json: {
        ...base,
        library_id: base.library_id + "-compact",
        documents: scoped.slice(offset, offset + 60),
        total: scoped.length,
        has_more: offset + 60 < scoped.length,
        next_cursor: offset + 60 < scoped.length ? String(offset + 60) : null,
        library_total: docs.length,
        folders,
        scoped_folders: counts,
        groups: ["Reference"],
        processing: false,
        processing_states: {},
        index_revision: indexRevision,
        organization_revision: "compact-static",
        ...organizationState,
      },
    });
  });
  await page.route("**/api/document?*", (route) => {
    const q = new URL(route.request().url()).searchParams,
      doc = docs.find((d) => d.document_id === q.get("id"))!,
      version = q.get("version") || "v2";
    return route.fulfill({
      json: {
        document: { ...doc, version },
        current_version: "v2",
        organization: doc,
        evidence: [passage(doc, version)],
        versions: [{ ...doc, version: "v1" }, doc],
        connections:
          version === "v2" &&
          [docs[0].document_id, docs[1].document_id].includes(doc.document_id)
            ? [link]
            : [],
      },
    });
  });
  await page.route("**/api/original-ready?*", (route) =>
    route.fulfill({ json: { ready: true } }),
  );
  await page.route("**/api/original?*", (route) => {
    const q = new URL(route.request().url()).searchParams;
    return route.fulfill({
      contentType: "text/plain",
      body: `# Saved ${q.get("version") || "v2"}\n\nReset preserves your files. Original files and all saved versions remain unchanged.\n\n## What gets rebuilt\n\n- Project and folder assignments\n- Generated relationships\n- Canvas organization\n\n## Version history\n\nOpen Versions to retrieve an earlier copy.\n\n| Field | ${"Wide column ".repeat(40)} |\n| --- | --- |\n| Version | Original bytes remain unchanged |\n\n${"Useful document reading remains comfortable.\n\n".repeat(20)}`,
    });
  });
  await page.route("**/api/card?*", (route) => {
    const doc = docs.find(
      (d) =>
        d.document_id === new URL(route.request().url()).searchParams.get("id"),
    )!;
    return route.fulfill({ json: { evidence: [passage(doc)] } });
  });
  await page.route("**/api/neighborhood?*", (route) =>
    route.fulfill({ json: { documents: [docs[0], docs[1]], links: [link] } }),
  );
  await page.route("**/api/link?*", (route) =>
    route.fulfill({
      json: { source: [passage(docs[0])], target: [passage(docs[1])], link },
    }),
  );
  const states = [
    "direct",
    "partial",
    "unknown",
    "related",
    "unrelated",
    "unchecked",
    "possible",
    "conflict",
    "visual",
    "outage",
    "context",
    "ocr",
  ];
  const matches = docs.slice(0, 18).map((d, i) => {
    const state = states[i % states.length],
      e = passage(d),
      support = ["direct", "partial", "unknown", "ocr"].includes(state);
    return {
      ...d,
      evidence: [state === "visual" ? { ...e, text: "", basis: "visual" } : e],
      jev: {
        status:
          state === "outage"
            ? "unavailable"
            : ["visual", "unchecked"].includes(state)
              ? "not_evaluated"
              : "evaluated",
        label: ["unknown", "context"].includes(state)
          ? "uncertain"
          : state === "ocr"
            ? "direct"
            : ["possible", "conflict"].includes(state)
              ? "related"
              : state,
        coverage:
          state === "unknown"
            ? "unknown"
            : state === "direct"
              ? "complete"
              : state === "partial"
                ? "partial"
                : "none",
        evidence_presence: support ? "supported" : "not_established",
        supporting_chunk_ids: support ? [e.evidence_id] : [],
        conflicting_chunk_ids: state === "conflict" ? [e.evidence_id] : [],
        possible_conflicting_chunk_ids:
          state === "possible" ? [e.evidence_id] : [],
        explanation:
          "Fixture decision: supporting facts are separate from coverage; possible conflicts require verification.",
        basis:
          state === "visual"
            ? "visual_match"
            : state === "ocr"
              ? ["ocr"]
              : ["text"],
      },
    };
  });
  await page.route(/\/api\/(?:search|ask)$/, (route) => {
    const args = route.request().postDataJSON();
    searches.push(args);
    const filtered = matches.filter(
      (d) =>
        args.folder === undefined ||
        d.folder === args.folder ||
        (!!args.folder && d.folder.startsWith(args.folder + " / ")),
    );
    return route.fulfill({
      json: {
        matches: filtered,
        status: "ok",
        evaluation: { status: "unavailable" },
      },
    });
  });
  return {
    docs,
    folders,
    matches,
    searches,
    libraryRequests,
    refreshUnchangedDocuments: () => {
      indexRevision = "compact-refreshed";
    },
    link,
    organization: (state: Record<string, unknown>) => {
      organizationState = state;
    },
  };
}
async function storageScope(page: Page) {
  await page.goto("/");
  await chooseView(page, "List");
  await page
    .getByRole("button", { name: "Expand Symbiknow", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Symbiknow \/ Storage \d+$/, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Storage", exact: true }),
  ).toBeVisible();
}

for (const size of [
  { width: 1600, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`compact desktop measurements and presentations ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await fixture(page);
    await storageScope(page);
    const row = page.getByRole("button", {
      name: /^Select Reset and recovery(?:\.[^.]+)?$/,
      exact: true,
    });
    await row.click();
    await expect(page.getByLabel("Document inspector")).toHaveCount(0);
    await row.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Saved v2", exact: true }),
    ).toBeVisible();
    await splitReader(page);
    const metrics = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll(".file-table tbody tr")],
        viewport = document.querySelector("main")!.getBoundingClientRect();
      return {
        ui: getComputedStyle(
          document.querySelector(".file-description strong")!,
        ).fontSize,
        row: nodes[0].getBoundingClientRect().height,
        toolbar: document.querySelector(".topbar")!.getBoundingClientRect()
          .height,
        reader: getComputedStyle(document.querySelector(".inspector .prose")!)
          .fontSize,
        sidebarRow: document
          .querySelector(".folder-nav-row")!
          .getBoundingClientRect().height,
        wholeRows: nodes.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.top >= viewport.top + 92 && r.bottom <= viewport.bottom - 32;
        }).length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(metrics.ui).toBe("13px");
    expect(metrics.row).toBeGreaterThanOrEqual(44);
    expect(metrics.row).toBeLessThanOrEqual(64);
    expect(metrics.toolbar).toBeGreaterThanOrEqual(64);
    expect(metrics.toolbar).toBeLessThanOrEqual(112);
    expect(metrics.reader).toBe("15px");
    expect(metrics.sidebarRow).toBeGreaterThanOrEqual(28);
    expect(metrics.overflow).toBe(false);
    if (size.width >= 1440)
      expect(metrics.wholeRows).toBeGreaterThanOrEqual(
        size.width === 1600 ? 6 : 4,
      );
    await capture(page, `list-reader-${size.width}`);
    await fs.writeFile(
      path.join(out, `dimensions-${size.width}.json`),
      JSON.stringify(metrics, null, 2),
    );
    await page.getByLabel("Display density").selectOption("comfortable");
    expect(
      await page
        .locator(".file-table tbody tr")
        .first()
        .evaluate((n) => n.getBoundingClientRect().height),
    ).toBeGreaterThan(metrics.row);
    await capture(page, `comfortable-${size.width}`);
    await page.getByLabel("Display density").selectOption("compact");
    await page
      .getByRole("button", { name: "Expand reader", exact: true })
      .click();
    await capture(page, `expanded-reader-${size.width}`);
    await page.getByRole("button", { name: "Show file list", exact: true }).click();
    await page
      .getByRole("button", {
        name: /^(Back to library|Close inspector)$/,
        exact: true,
      })
      .click();
    await chooseView(page, "Cards");
    await expect(page.locator(".grid-file")).toHaveCount(60);
    await capture(page, `cards-${size.width}`);
    await chooseView(page, "Canvas");
    await expect(
      page.locator(".react-flow__node-document").first(),
    ).toBeVisible();
    await capture(page, `canvas-${size.width}`);
  });
}

test("all search evidence meanings and presentation changes share one intent", async ({
  page,
}) => {
  const data = await fixture(page);
  await storageScope(page);
  await setAnswerChecking(page, true);
  await page.getByLabel("Search your knowledge").fill("reset and versions");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".file-row")).toHaveCount(18);
  const decisions = await page
    .locator(".file-table .judgment")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-decision")));
  for (const label of [
    "Supports answer",
    "Partially supports",
    "Supports · Coverage unknown",
    "Needs context",
    "Related",
    "Not relevant",
    "Not checked",
    "Possible conflict",
    "Conflicts with premise",
    "Visual match · Not checked",
  ]) {
    await expect(page.locator(".file-table")).toContainText(label);
  }
  await page
    .getByRole("button", {
      name: /^Select Reset and recovery(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: /^Select Reset and recovery(?:\.[^.]+)?$/,
      exact: true,
    })
    .press("Enter");
  await capture(page, "evaluated-list-reader");
  const requests = data.searches.length;
  await chooseView(page, "Cards");
  await expect(page.locator(".grid-file")).toHaveCount(18);
  await capture(page, "evaluated-cards");
  await chooseView(page, "Canvas");
  await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
  await capture(page, "evaluated-canvas");
  const canvasDecisions = await page
    .locator(".canvas-judgment .judgment")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-decision")));
  expect(canvasDecisions).toEqual(decisions);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByLabel("Connection visibility").selectOption("hidden");
  await chooseView(page, "List");
  await page
    .getByRole("separator", { name: "Resize sidebar", exact: true })
    .press("ArrowRight");
  await page
    .getByRole("separator", { name: "Resize inspector", exact: true })
    .press("ArrowLeft");
  expect(data.searches.length).toBe(requests);
  expect(
    await page
      .locator(".file-table .judgment")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-decision")),
      ),
  ).toEqual(decisions);
  await expect(page.getByLabel("Search your knowledge")).toHaveValue(
    "reset and versions",
  );
  await expectSearchMode(page, "semantic");
  await expect(page.locator('.file-row[aria-selected="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".file-table .judgment")).toHaveCount(0);
  await fs.writeFile(
    path.join(out, "shared-intent.json"),
    JSON.stringify({ requests: data.searches, decisions }, null, 2),
  );
});

test("canvas previews, collapsed search accounting, zoom and real link strip", async ({
  page,
}) => {
  const data = await fixture(page);
  await storageScope(page);
  await chooseView(page, "Canvas");
  await expect(page.locator(".frame-more").first()).toContainText("6 of");
  expect(
    await page.locator(".react-flow__node-document").count(),
  ).toBeLessThanOrEqual(24);
  await page
    .getByRole("button", {
      name: /^Select Reset and recovery(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  // A routed SVG curve's bounding-box center need not lie on its hit path.
  const point = await page
    .locator(".react-flow__edge-interaction")
    .evaluate((el) => {
      const path = el as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(
        path.getScreenCTM()!,
      );
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".link-strip")).toContainText(
    data.link.source_filename,
  );
  await expect(page.locator(".link-strip")).toContainText(
    data.link.target_filename,
  );
  await page
    .getByRole("button", { name: "View evidence", exact: true })
    .click();
  await expect(page.locator(".link-evidence")).toContainText("Source passage");
  await expect(page.locator(".link-evidence")).toContainText("Target passage");
  await capture(page, "connection-evidence");
  await page
    .getByRole("button", {
      name: /^(Back to library|Close inspector)$/,
      exact: true,
    })
    .click();
  await page.getByLabel("Search your knowledge").fill("reset");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
  await page
    .getByRole("button", { name: "Collapse Recovery", exact: true })
    .click();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(0);
  await expect(page.locator(".folder-heading")).toContainText("18 matches");
  await page
    .getByRole("button", { name: "Expand Recovery", exact: true })
    .click();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
  for (let i = 0; i < 5; i++)
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(page.locator(".canvas")).toHaveClass(/zoom-markers/);
  await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
  expect(data.searches.length).toBe(1);
  await capture(page, "semantic-zoom-markers");
});

test("loaded pagination selection, keyboard actions and pinned reader state", async ({
  page,
}) => {
  await fixture(page);
  await storageScope(page);
  const row = page.getByRole("button", {
    name: /^Select Reset and recovery(?:\.[^.]+)?$/,
    exact: true,
  });
  await row.click();
  await page.keyboard.press("Meta+a");
  await expect(page.getByText("60 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".file-row")).toHaveCount(36);
  await expect(page.getByText("60 selected", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(page.locator(".file-row")).toHaveCount(60);
  await row.click();
  await page.keyboard.press("Meta+a");
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await row.click();
  await row.press("Enter");
  await page.getByLabel("Preview version").selectOption("v1");
  await expect(
    page.getByRole("heading", { name: "Saved v1", exact: true }),
  ).toBeVisible();
  await chooseView(page, "Cards");
  await chooseView(page, "Canvas");
  await page
    .getByRole("button", {
      name: /^Select Reset and recovery(?:\.[^.]+)?$/,
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Preview version")).toHaveValue("v1");
  await chooseView(page, "List");
  await expect(page.getByLabel("Preview version")).toHaveValue("v1");
  await page
    .getByRole("button", { name: "Expand reader", exact: true })
    .click();
  await expect(page.getByLabel("Preview version")).toHaveValue("v1");
  await page.getByRole("button", { name: "Show file list", exact: true }).click();
  await page
    .getByRole("button", {
      name: /^(Back to library|Close inspector)$/,
      exact: true,
    })
    .click();
  await expect(row).toBeFocused();
  await row.press("ArrowDown");
  expect(await page.locator('.file-row[aria-selected="true"]').count()).toBe(1);
  await capture(page, "long-filename");
});

test("canvas positions and viewport survive views and unchanged background refresh; search has separate storage", async ({
  page,
}) => {
  await page.clock.install();
  const data = await fixture(page);
  await storageScope(page);
  await chooseView(page, "Canvas");
  await expect(page.locator(".react-flow__node-document")).toHaveCount(24);
  const node = page.locator(".react-flow__node-document").first();
  const id = await node.getAttribute("data-id");
  const handle = node.locator(".card-handle > svg");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 22, box.y + 15, { steps: 6 });
  await page.mouse.up();
  const position = await node.getAttribute("style");
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  const viewport = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await chooseView(page, "List");
  await chooseView(page, "Canvas");
  await expect(
    page.locator(`.react-flow__node-document[data-id="${id}"]`),
  ).toHaveAttribute("style", position!);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    viewport!,
  );
  const requests = data.libraryRequests.length;
  // Exercise a real revision-triggered reload with unchanged document metadata,
  // independent of the unrelated backend fixture's revision and response time.
  data.refreshUnchangedDocuments();
  await page.clock.runFor(4200);
  await expect
    .poll(() => data.libraryRequests.length)
    .toBeGreaterThan(requests);
  await expect(
    page.locator(`.react-flow__node-document[data-id="${id}"]`),
  ).toHaveAttribute("style", position!);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    viewport!,
  );
  await page.getByLabel("Search your knowledge").fill("reset");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".react-flow__node-document")).toHaveCount(18);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  const collapse = page.getByRole("button", {
    name: "Collapse Recovery",
    exact: true,
  });
  if (!(await collapse.isVisible())) {
    // The full map may fit below the marker threshold in a shorter pane. Use
    // its readable group navigation before interacting with folder controls.
    await page
      .getByRole("navigation", { name: "Folder groups at low zoom" })
      .getByRole("button", { name: "Recovery 18 matches", exact: true })
      .click();
  }
  await expect(collapse).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse Recovery", exact: true })
    .click();
  await chooseView(page, "List");
  await chooseView(page, "Canvas");
  await expect(
    page.getByRole("button", { name: "Expand Recovery", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    viewport!,
  );
  await expect(
    page.locator(`.react-flow__node-document[data-id="${id}"]`),
  ).toHaveAttribute("style", position!);
  expect(data.searches.length).toBe(1);
  await fs.writeFile(
    path.join(out, "canvas-persistence.json"),
    JSON.stringify(
      {
        id,
        position,
        viewport,
        libraryRequests: data.libraryRequests.length,
        searches: data.searches.length,
      },
      null,
      2,
    ),
  );
});

test("active query scope discards delayed responses; disclosure and filter popover stay local", async ({
  page,
}) => {
  const data = await fixture(page);
  await storageScope(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests: any[] = [];
  await page.route(/\/api\/(?:search|ask)$/, async (route) => {
    const args = route.request().postDataJSON();
    requests.push(args);
    if (args.folder === "Symbiknow / Storage") await gate;
    await route.fulfill({
      json: {
        status: "ok",
        evaluation: { status: "not_requested" },
        matches: args.folder?.endsWith("Versioning")
          ? [data.docs.find((d) => d.folder.endsWith("Versioning"))!]
          : data.matches,
      },
    });
  });
  try {
    await page.getByLabel("Search your knowledge").fill("history");
    await page.getByLabel("Search your knowledge").press("Enter");
    await expect.poll(() => requests.length).toBe(1);
    await page
      .getByRole("button", { name: "Expand Symbiknow / Storage", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: /^Search scope and filters(?: \d+)?$/,
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    expect(requests.length).toBe(1);
    await page
      .locator(".sidebar")
      .getByRole("button", {
        name: /^Symbiknow \/ Storage \/ Versioning \d+$/,
        exact: true,
      })
      .click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator(".file-row")).toHaveCount(1);
    release();
    await expect(page.locator(".file-row")).toHaveCount(1);
    await expect(page.locator(".file-row")).toContainText(
      data.docs.find((d) => d.folder.endsWith("Versioning"))!.filename,
    );
    await expect(
      page.getByRole("button", {
        name: /^Clear folder scope(?:: .+)?$/,
        exact: true,
      }),
    ).toContainText("Versioning");
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Versioning", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".judgment")).toHaveCount(0);
    expect(requests.length).toBe(2);
  } finally {
    release();
  }
});

test("reset moves files to New then visibly rebuilds folders before the job finishes", async ({
  page,
}) => {
  const data = await fixture(page);
  let revision = "compact-static";
  let job: Record<string, unknown> | null = null;
  await page.route("**/api/progress", (route) =>
    route.fulfill({
      json: {
        index_revision: "compact-static",
        organization_revision: revision,
        processing: false,
      },
    }),
  );
  await page.route("**/api/rebuild", (route) => {
    if (route.request().method() === "POST") {
      for (const doc of data.docs) {
        doc.folder = "New";
        doc.groups = [];
      }
      for (const key of Object.keys(data.folders)) delete data.folders[key];
      data.folders.New = 96;
      revision = "reset-cleared";
      data.organization({
        organization_revision: revision,
        groups: [],
        organization_reset: { revision: "reset-publication-test", scope: null },
      });
      job = {
        request_id: "reset-publication-test",
        mode: "reset",
        status: "running",
        phase: "preparing",
        activity: "Reviewing folders and links",
        total: 96,
        completed: 0,
        failed: 0,
        skipped: 0,
        unfiled: 0,
        grouped: 0,
        links_added: 0,
        grouping: true,
        links: true,
      };
    }
    return route.fulfill({ json: job });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Symbiknow 96", exact: true }),
  ).toBeVisible();
  await chooseView(page, "Map");
  await expect(
    page.getByRole("region", { name: "Symbiknow map cluster", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Library actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Reset organization…", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "move to New before scanning starts",
  );
  await page
    .getByRole("button", { name: "Reset & rebuild", exact: true })
    .click();
  const activity = page.getByRole("region", { name: "Jev activity" });
  await expect(activity).toContainText(
    "Files move from New into rebuilt folders",
  );
  await expect(activity).toContainText("0 / 96 files");
  await expect(
    page.getByRole("button", { name: "New 96", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Symbiknow 96", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "New map cluster", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Symbiknow map cluster", exact: true }),
  ).toHaveCount(0);

  // One reviewed file appears in its new folder while the rest remain in New.
  // Polling must update the actual folder tree, without a reload or manual refresh.
  data.docs[0].folder = "Reset result / Ready";
  data.docs[0].groups = ["Rebuilt"];
  data.folders.New = 95;
  data.folders["Reset result / Ready"] = 1;
  revision = "reset-first-file";
  data.organization({
    organization_revision: revision,
    groups: ["Rebuilt"],
    organization_reset: { revision: "reset-publication-test", scope: null },
  });
  job = { ...job, completed: 1, grouped: 1, links_added: 1 };
  await expect(
    page.getByRole("button", { name: "Reset result 1", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", { name: "New 95", exact: true }),
  ).toBeVisible();
  await expect(activity).toContainText("1 / 96 files");
  await expect(activity).toContainText("1 links added");
  await expect(
    page.getByRole("region", { name: "Reset result map cluster", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "New map cluster", exact: true }),
  ).toContainText("95 total");
  await capture(page, "reset-rebuilding-live");

  for (const doc of data.docs) doc.folder = "Reset result / Ready";
  data.docs[0].folder = "";
  for (const key of Object.keys(data.folders)) delete data.folders[key];
  data.folders["Reset result / Ready"] = 95;
  data.folders[""] = 1;
  revision = "reset-published";
  data.organization({
    organization_revision: revision,
    organization_reset: { revision: "reset-publication-test", scope: null },
  });
  job = {
    ...job,
    status: "completed",
    phase: "complete",
    completed: 96,
    activity: "Complete",
    layout_revision: "reset-publication-test",
    unfiled: 1,
  };
  await expect(
    page.getByRole("button", { name: "Reset result 95", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", { name: "Symbiknow 96", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New 95", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Library actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Show review status", exact: true })
    .click();
  await expect(page.getByLabel("Review status", { exact: true })).toContainText(
    "Organization reset complete",
  );
  await expect(
    page.getByRole("progressbar", { name: "Jev review progress" }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Review status", { exact: true }),
  ).not.toContainText("Files move from New");
});

test("folder reset revisions clear affected tree and canvas storage, while links-only preserves placement", async ({
  page,
}) => {
  const data = await fixture(page);
  await storageScope(page);
  const prefix = await page.evaluate(() =>
    Object.keys(localStorage)
      .find((k) => k.endsWith(".organizationRevision"))!
      .replace("organizationRevision", ""),
  );
  const recovery = "Symbiknow / Storage / Recovery",
    versioning = "Symbiknow / Storage / Versioning";
  const state = {
    positions: { "compact-0": { x: 55, y: 66 } },
    folderById: { "compact-0": recovery },
    collapsed: [recovery],
    viewport: { x: 10, y: 20, zoom: 1 },
  };
  await page.evaluate(
    ({ prefix, recovery, versioning, state }) => {
      localStorage.setItem(
        prefix + "canvas:" + recovery,
        JSON.stringify(state),
      );
      localStorage.setItem(
        prefix + "canvas:" + recovery + "|search:heldout",
        JSON.stringify(state),
      );
      localStorage.setItem(
        prefix + "canvas:" + versioning,
        JSON.stringify({
          ...state,
          positions: { "compact-19": { x: 55, y: 66 } },
          folderById: { "compact-19": versioning },
          collapsed: [versioning],
        }),
      );
      localStorage.setItem(
        prefix + "expanded",
        JSON.stringify([
          "Symbiknow",
          "Symbiknow / Storage",
          recovery,
          versioning,
        ]),
      );
    },
    { prefix, recovery, versioning, state },
  );
  async function refresh() {
    await page
      .getByRole("button", { name: "Library actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Refresh library", exact: true })
      .click();
  }
  data.organization({ organization_revision: "links-only" });
  await refresh();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "organizationRevision",
      ),
    )
    .toBe('"links-only"');
  expect(
    JSON.parse(
      (await page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "canvas:" + recovery,
      ))!,
    ),
  ).toEqual(state);
  data.organization({
    organization_revision: "scoped",
    organization_reset: { revision: "scope-reset", scope: recovery },
  });
  await refresh();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "canvas:" + recovery,
      ),
    )
    .toBeNull();
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      prefix + "canvas:" + recovery + "|search:heldout",
    ),
  ).toBeNull();
  expect(
    JSON.parse(
      (await page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "canvas:" + versioning,
      ))!,
    ),
  ).toEqual({
    ...state,
    positions: { "compact-19": { x: 55, y: 66 } },
    folderById: { "compact-19": versioning },
    collapsed: [versioning],
  });
  expect(
    JSON.parse(
      (await page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "expanded",
      ))!,
    ),
  ).toEqual(["Symbiknow", "Symbiknow / Storage", versioning]);
  data.organization({
    organization_revision: "full",
    organization_reset: { revision: "full-reset", scope: null },
  });
  await refresh();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "canvas:" + versioning,
      ),
    )
    .toBeNull();
  expect(
    JSON.parse(
      (await page.evaluate(
        (key) => localStorage.getItem(key),
        prefix + "expanded",
      ))!,
    ),
  ).toEqual([]);
  await fs.writeFile(
    path.join(out, "reset-presentation.json"),
    JSON.stringify(
      {
        linksOnlyPreserved: true,
        scopedPreservedSibling: true,
        fullClearedTreeAndCanvas: true,
      },
      null,
      2,
    ),
  );
});

test("readable contrast, reduced motion, persistent density, context selection and narrow reading", async ({
  page,
}) => {
  await fixture(page);
  await storageScope(page);
  const row = page.getByRole("button", {
    name: /^Select Reset and recovery(?:\.[^.]+)?$/,
    exact: true,
  });
  await row.click();
  await expect(page.getByLabel("Document inspector")).toHaveCount(0);
  await row.press("Enter");
  const colors = await page.locator(".app").evaluate((el) => {
    const css = getComputedStyle(el);
    return Object.fromEntries(
      [
        "--text",
        "--text-secondary",
        "--surface",
        "--surface-sidebar",
        "--accent",
        "--selection",
        "--duration-fast",
      ].map((key) => [key, css.getPropertyValue(key).trim()]),
    );
  });
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const contrast = (a: string, b: string) => {
    const x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const ratios = {
    text: contrast(colors["--text"], colors["--surface"]),
    metadata: contrast(colors["--text-secondary"], colors["--surface"]),
    sidebarMetadata: contrast(
      colors["--text-secondary"],
      colors["--surface-sidebar"],
    ),
    selectedText: contrast(colors["--accent"], colors["--selection"]),
  };
  expect(Math.min(...Object.values(ratios))).toBeGreaterThanOrEqual(4.5);
  expect(colors["--duration-fast"]).toBe("0ms");
  await splitReader(page);
  await page.getByLabel("Display density").selectOption("comfortable");
  await page.reload();
  await expect(page.getByLabel("Display density")).toHaveValue("comfortable");
  await row.press("Enter");
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.getByLabel("Document inspector")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("main")).toBeHidden();
  await capture(page, "narrow-desktop-reader-1024");
  await page
    .getByRole("button", {
      name: /^(Back to library|Close inspector)$/,
      exact: true,
    })
    .click();
  await expect(row).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await row.click();
  const second = page
    .locator(".file-row")
    .filter({ hasText: "Storage policy 002.md" })
    .getByRole("button", { name: /^Select / });
  await second.click({ modifiers: ["Meta"] });
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: "File actions for Storage policy 003.md",
      exact: true,
    })
    .click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await chooseView(page, "Canvas");
  const cards = page.locator(".canvas-title");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(page.locator(".canvas-document.selected")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await cards.nth(0).press("Space");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await fs.writeFile(
    path.join(out, "accessibility.json"),
    JSON.stringify(
      {
        colors,
        ratios,
        reducedMotion: true,
        densityPersisted: true,
        narrowCssViewport: 1024,
        contextMenuPreservedSelection: true,
        canvasMultiSelect: true,
      },
      null,
      2,
    ),
  );
});

test("legacy Canvas overview fits every folder group, preserves detailed placements and stays readable at low zoom", async ({
  page,
}) => {
  const data = await fixture(page);
  await storageScope(page);
  const prefix = await page.evaluate(() =>
    Object.keys(localStorage)
      .find((k) => k.endsWith(".organizationRevision"))!
      .replace("organizationRevision", ""),
  );
  const positions: Record<string, { x: number; y: number }> = {};
  Object.keys(data.folders).forEach(
    (f, i) => (positions["folder:" + f] = { x: 24, y: 1956 + i * 3200 }),
  );
  data.docs.forEach(
    (d, i) =>
      (positions[d.document_id] = {
        x: 14 + (i % 2) * 278,
        y: 54 + Math.floor(i / 2) * 264,
      }),
  );
  const legacy = {
    positions,
    folderById: Object.fromEntries(
      data.docs.map((d) => [d.document_id, d.folder]),
    ),
    overview: true,
    collapsed: [],
    viewport: { x: 515, y: -973, zoom: 0.15 },
  };
  await page.evaluate(
    ({ key, legacy }) => localStorage.setItem(key, JSON.stringify(legacy)),
    { key: prefix + "canvas:Symbiknow / Storage", legacy },
  );
  await chooseView(page, "Canvas");
  await expect(page.locator(".react-flow__node-folder")).toHaveCount(4);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".canvas").evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return Array.from(
          canvas.querySelectorAll(".react-flow__node-folder"),
        ).every((n) => {
          const r = n.getBoundingClientRect();
          return (
            r.left >= bounds.left &&
            r.right <= bounds.right &&
            r.top >= bounds.top + 40 &&
            r.bottom <= bounds.bottom - 24
          );
        });
      }),
    )
    .toBe(true);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    prefix + "canvas:Symbiknow / Storage",
  );
  expect(saved.positions).toEqual(positions);
  expect(
    Math.max(...Object.values(saved.overviewPositions).map((p: any) => p.y)),
  ).toBeLessThan(1000);
  await capture(page, "legacy-overview-fit-all-groups");
  const zoomPercentage = async () =>
    Number((await page.locator(".zoom-percent").innerText()).replace("%", ""));
  for (let i = 0; i < 30 && (await zoomPercentage()) > 15; i++) {
    const before = await zoomPercentage();
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.poll(zoomPercentage).toBeLessThan(before);
  }
  const minimumView = await zoomPercentage();
  expect(minimumView).toBeGreaterThanOrEqual(1);
  expect(minimumView).toBeLessThanOrEqual(15);
  const summary = page.getByRole("navigation", {
    name: "Folder groups at low zoom",
    exact: true,
  });
  await expect(summary).toBeVisible();
  for (const name of ["Decisions", "Integrity", "Recovery", "Versioning"])
    await expect(summary).toContainText(name);
  expect(await summary.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "12px",
  );
  await capture(page, "all-groups-low-zoom");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(summary).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator(".canvas").evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return Array.from(
          canvas.querySelectorAll(".react-flow__node-folder"),
        ).every((n) => {
          const r = n.getBoundingClientRect();
          return (
            r.left >= bounds.left &&
            r.right <= bounds.right &&
            r.top >= bounds.top + 40 &&
            r.bottom <= bounds.bottom - 24
          );
        });
      }),
    )
    .toBe(true);
  expect(data.searches.length).toBe(0);
  await fs.writeFile(
    path.join(out, "legacy-canvas-regression.json"),
    JSON.stringify(
      {
        legacyViewport: legacy.viewport,
        groups: 4,
        allFit: true,
        detailPlacementsPreserved: true,
        readableLowZoom: true,
        searchRequests: 0,
      },
      null,
      2,
    ),
  );
});
