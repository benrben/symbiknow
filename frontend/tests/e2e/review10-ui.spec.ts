import { chooseView, setAnswerChecking } from "../support/ui-controls";
import { test, expect } from "../support/coverage";
import type { Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
const pinned = JSON.parse(
  readFileSync(
    new URL("../fixtures/review10-readme.json", import.meta.url),
    "utf8",
  ),
);
const out = path.resolve("../artifacts/review10-followup/ui");

async function capture(page: Page, name: string, value?: unknown) {
  await fs.mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name + ".png") });
  if (value)
    await fs.writeFile(
      path.join(out, name + ".json"),
      JSON.stringify(value, null, 2),
    );
}
async function fixture(page: Page) {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const readme = pinned[0].match;
  const docs: any[] = Array.from({ length: 40 }, (_, i) =>
    i === 0
      ? readme
      : {
          ...readme,
          document_id: `review10-${i}`,
          filename: `Upgrade document ${i}.md`,
          folder:
            i < 8
              ? "Symbiknow"
              : `Symbiknow / Topic ${Math.floor((i - 8) / 4)}`,
          evidence: [
            {
              ...readme.evidence[1],
              evidence_id: `review10-${i}:v2:t0`,
              text: "Original file bytes remain preserved. This is an authored browser layout fixture.",
            },
          ],
          jev: {
            status: "evaluated",
            label: "direct",
            coverage: "complete",
            supporting_chunk_ids: [`review10-${i}:v2:t0`],
            explanation:
              "Authored browser fixture, not model accuracy evidence.",
          },
        },
  );
  const folders: Record<string, number> = {};
  docs.forEach((d) => (folders[d.folder] = (folders[d.folder] || 0) + 1));
  await page.route("**/api/library?*", (route) => {
    const scope = new URL(route.request().url()).searchParams.get("folder");
    const subset = docs.filter(
      (d) => !scope || d.folder === scope || d.folder.startsWith(scope + " / "),
    );
    return route.fulfill({
      json: {
        ...base,
        library_id: base.library_id + "-review10",
        documents: subset,
        total: subset.length,
        has_more: false,
        folders,
        scoped_folders: folders,
        index_revision: "review10-static",
        organization_revision: "review10-static",
        processing: false,
      },
    });
  });
  const searches: any[] = [];
  await page.route(/\/api\/(?:search|ask)$/, (route) => {
    const args = route.request().postDataJSON();
    searches.push(args);
    const p = pinned.find((p) => p.query === args.query) || pinned[0];
    return route.fulfill({
      json: {
        status: "ok",
        matches: [p.match, ...docs.slice(1)],
        evaluation: { status: "evaluated" },
      },
    });
  });
  await page.route("**/api/document?*", (route) => {
    const q = new URL(route.request().url()).searchParams,
      d = docs.find((d) => d.document_id === q.get("id"))!;
    const version = q.get("version") || "v2";
    return route.fulfill({
      json: {
        document: { ...d, version },
        current_version: "v2",
        organization: version === "v2" ? d : null,
        evidence: version === "v2" ? d.evidence : [],
        connections: [],
        versions: [{ ...d, version: "v1" }, d],
      },
    });
  });
  await page.route("**/api/original-ready?*", route => route.fulfill({ json: { ready: true } }));
  await page.route("**/api/original?*", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body:
        new URL(route.request().url()).searchParams.get("version") === "v1"
          ? "# Earlier README\n\nHistorical document only."
          : readme.evidence.map((e) => e.text).join("\n\n"),
    }),
  );
  await page.goto("/");
  await chooseView(page, "List");
  await page
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  await setAnswerChecking(page, true);
  await page.getByLabel("Search your knowledge").fill(pinned[0].query);
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".file-row")).toHaveCount(40);
  return { docs, searches };
}
async function layoutKey(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).find((k) =>
      k.includes("canvas:Symbiknow|search:"),
    )!,
  );
}
async function stored(page: Page, key: string) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), key);
}
async function rectangles(page: Page) {
  await expect(page.locator(".canvas-document")).toHaveCount(40);
  return page.locator(".canvas-document").evaluateAll((nodes) => {
    const cards = nodes.map((n) => ({
      id: n.getAttribute("data-document-id"),
      rect: n.getBoundingClientRect().toJSON(),
      height: Number(
        (n.parentElement as HTMLElement).style.height.replace("px", ""),
      ),
      legacy: n.classList.contains("legacy-card"),
    }));
    const overlaps: any[] = [];
    cards.forEach((a, i) =>
      cards.slice(i + 1).forEach((b) => {
        const x = a.rect,
          y = b.rect;
        if (
          x.left < y.right - 0.5 &&
          x.right > y.left + 0.5 &&
          x.top < y.bottom - 0.5 &&
          x.bottom > y.top + 0.5
        )
          overlaps.push([a.id, b.id]);
      }),
    );
    return { cards, overlaps };
  });
}
async function seed(page: Page, docs: any[], known = false) {
  await chooseView(page, "Canvas");
  await expect(page.locator(".canvas-document")).toHaveCount(40);
  await chooseView(page, "List");
  const key = await layoutKey(page);
  const positions: Record<string, { x: number; y: number }> = {},
    folderById: Record<string, string> = {},
    positionOrigins: Record<string, string> = {};
  const groups = new Map<string, any[]>();
  docs.forEach((d) => {
    const path = d.folder === "Symbiknow" ? "" : d.folder;
    groups.set(path, [...(groups.get(path) || []), d]);
  });
  let frameY = 24;
  for (const [folder, rows] of groups) {
    positions["folder:" + folder] = { x: 24, y: frameY };
    positionOrigins["folder:" + folder] = known ? "generated" : "legacy";
    rows.forEach((d, i) => {
      positions[d.document_id] = {
        x: 12 + (i % 2) * 186,
        y: 44 + Math.floor(i / 2) * (folder ? 124 : 200),
      };
      folderById[d.document_id] = d.folder;
      positionOrigins[d.document_id] = known ? "generated" : "legacy";
    });
    frameY += folder ? 340 : 920;
  }
  // A deliberate placement has a known provenance and remains pinned through upgrade.
  const manual = docs[7].document_id;
  positions[manual] = { x: 198, y: 744 };
  positionOrigins[manual] = "manual";
  const state = {
    positions,
    folderById,
    positionOrigins,
    collapsed: [],
    overview: false,
    viewport: { x: 30, y: 60, zoom: 1 },
    ...(known
      ? { geometry: { version: 1, cardWidth: 174, cardHeight: 112 } }
      : {}),
  };
  await page.evaluate(
    ({ key, state }) => localStorage.setItem(key, JSON.stringify(state)),
    { key, state },
  );
  await chooseView(page, "Canvas");
  await expect(page.locator(".canvas-document")).toHaveCount(40);
  return { key, state, manual };
}

test("legacy124-pitch upgrade offers reversible reflow, retains16collision history and manual coordinates through views and reload", async ({
  page,
}) => {
  const data = await fixture(page),
    old = await seed(page, data.docs);
  await expect(
    page.getByRole("status", { name: "Saved layout upgrade" }),
  ).toBeVisible();
  // The old fixed142px renderer would intersect16pairs; compatibility cards
  // remain112px until an explicit user action, without moving the old coordinates.
  const predicted = Object.entries(old.state.positions)
    .filter(([id]) => !id.startsWith("folder:"))
    .reduce(
      (n, [a, x], i, all) =>
        n +
        all
          .slice(i + 1)
          .filter(
            ([b, y]) =>
              old.state.folderById[a] === old.state.folderById[b] &&
              x.x < y.x + 174 &&
              x.x + 174 > y.x &&
              x.y < y.y + 142 &&
              x.y + 142 > y.y,
          ).length,
      0,
    );
  expect(predicted).toBe(16);
  const before = await rectangles(page);
  expect(before.overlaps).toEqual([]);
  expect(before.cards.filter((c) => c.legacy)).toHaveLength(32);
  expect((await stored(page, old.key)).positions).toEqual(old.state.positions);
  await capture(page, "legacy-compatibility", {
    predictedOldRendererCollisions: predicted,
    ...before,
  });
  const requests = data.searches.length;
  await page
    .getByRole("button", { name: "Reflow saved layout", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("status", { name: "Saved layout upgrade" }),
  ).toHaveCount(0);
  const after = await rectangles(page);
  expect(after.overlaps).toEqual([]);
  expect(after.cards.every((c) => c.height === 224 || c.height === 72)).toBe(
    true,
  );
  expect((await stored(page, old.key)).positions[old.manual]).toEqual(
    old.state.positions[old.manual],
  );
  await capture(page, "legacy-reflow", after);
  for (const view of ["List", "Cards", "Canvas"]) {
    await chooseView(page, view);
  }
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await rectangles(page)).overlaps).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).press("Enter");
  await expect(
    page.getByRole("status", { name: "Saved layout upgrade" }),
  ).toBeVisible();
  expect((await stored(page, old.key)).positions).toEqual(old.state.positions);
  await expect.poll(async () => (await rectangles(page)).overlaps).toEqual([]);
  await page
    .getByRole("button", { name: "Reflow saved layout", exact: true })
    .click();
  await page.reload();
  await expect(
    page.locator(".app"),
  ).toHaveClass(/map-view/);
  await page
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  // Search itself is not persisted; returning to the identical scope/query uses
  // the upgraded map and the persisted undo snapshot rather than fresh layout.
  await page.getByLabel("Search your knowledge").fill(pinned[0].query);
  await page.getByLabel("Search your knowledge").press("Enter");
  // Folder navigation opens the file workspace; explicitly return to the saved map.
  await chooseView(page, "Canvas");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await rectangles(page)).overlaps).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Saved layout upgrade" }),
  ).toBeVisible();
  expect((await stored(page, old.key)).positions).toEqual(old.state.positions);
  expect(data.searches.length).toBe(requests + 1);
  await capture(page, "legacy-reloaded-undo", {
    original: old.state,
    current: await stored(page, old.key),
    requests: data.searches,
  });
});

test("versioned generated112px layouts migrate automatically while intentionalmanual position stays pinned", async ({
  page,
}) => {
  const data = await fixture(page),
    old = await seed(page, data.docs, true);
  await expect(
    page.getByRole("status", { name: "Saved layout upgrade" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => (await stored(page, old.key)).geometry?.version)
    .toBe(3);
  await expect.poll(async () => (await rectangles(page)).overlaps).toEqual([]);
  const saved = await stored(page, old.key);
  expect(saved.positions[old.manual]).toEqual(old.state.positions[old.manual]);
  expect(saved.positionOrigins[old.manual]).toBe("manual");
  expect(saved.positions[data.docs[10].document_id]).not.toEqual(
    old.state.positions[data.docs[10].document_id],
  );
  for (const view of ["List", "Cards", "Canvas"]) {
    await chooseView(page, view);
  }
  await expect(page.locator(".canvas-document")).toHaveCount(40);
  expect((await stored(page, old.key)).positions).toEqual(saved.positions);
  await capture(page, "generated-upgrade", {
    before: old.state,
    after: saved,
    geometry: await rectangles(page),
  });
});

for (const view of ["List", "Cards", "Canvas"])
  test(`repeated samebadge and historicalv1 navigation return to requestedv2 evidence from ${view}`, async ({
    page,
  }) => {
    const data = await fixture(page);
    await chooseView(page, view);
    if (view === "Canvas") {
      await page
        .getByRole("button", {
          name: /^Select Symbiknow README(?:\.[^.]+)?$/,
          exact: true,
        })
        .click();
      // Focus the group locally so its full keyboard action remains visible.
      const nav = page.getByRole("navigation", {
        name: "Folder groups at low zoom",
      });
      if (await nav.count())
        await nav.getByRole("button", { name: /Symbiknow 8/ }).click();
    }
    const badge = page.getByRole("button", {
      name: "View evidence for Symbiknow README.md",
      exact: true,
    });
    const check = async () => {
      await expect(
        page.getByRole("tab", { name: "Evidence", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Preview version")).toHaveValue("v2");
      await expect(
        page.locator(
          '[id="evidence-ee07d919-4fb8-5af5-848e-69efc0e03aa8:v2:t0"]',
        ),
      ).toContainText("without Git");
      await expect(
        page.getByRole("region", { name: "Search evidence" }),
      ).toBeFocused();
    };
    await badge.press("Enter");
    await check();
    await page.getByRole("tab", { name: "Document", exact: true }).click();
    await badge.press("Enter");
    await check();
    await page.getByLabel("Preview version").selectOption("v1");
    await expect(page.locator(".why-file")).toHaveCount(0);
    await expect(page.getByLabel("Download v1")).toHaveAttribute(
      "href",
      /version=v1/,
    );
    await badge.press("Enter");
    await check();
    await page
      .getByRole("button", {
        name: /^(Back to library|Close inspector)$/,
        exact: true,
      })
      .click();
    await expect(badge).toBeFocused();
    await badge.press("Enter");
    await check();
    expect(data.searches.length).toBe(1);
    await capture(page, `repeat-evidence-${view}`, {
      requests: data.searches,
      version: await page.getByLabel("Preview version").inputValue(),
      evidence: await page.locator(".why-file").innerText(),
    });
  });

for (const record of pinned)
  test(`pinnedREADME decimal and multiline excerpt preserves subject mechanism negation: ${record.query}`, async ({
    page,
  }) => {
    const data = await fixture(page);
    if (record.query !== pinned[0].query) {
      await page.getByLabel("Search your knowledge").fill(record.query);
      await page.getByLabel("Search your knowledge").press("Enter");
    }
    await chooseView(page, "Cards");
    const preview = page.locator(
      `.grid-file[data-document-id="${record.match.document_id}"] .card-prose`,
    );
    await expect(preview).toContainText(
      "Original bytes and independent document histories",
    );
    await expect(preview).toContainText("OCFL repository");
    await expect(preview).toContainText("rocfl 1.7.0");
    await expect(preview).toContainText("without Git");
    const visiblePhrases = async (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const box = el.closest(".content-card")!.getBoundingClientRect();
        return ["Original bytes", "without Git"].map((phrase) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const index = (node.textContent || "").indexOf(phrase);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + phrase.length);
            const rect = range.getBoundingClientRect();
            return {
              phrase,
              visible:
                rect.left >= box.left &&
                rect.right <= box.right + 1 &&
                rect.top >= box.top &&
                rect.bottom <= box.bottom + 1,
              rect: rect.toJSON(),
              box: box.toJSON(),
            };
          }
          return { phrase, visible: false };
        });
      });
    const cardsRange = await visiblePhrases(
      `.grid-file[data-document-id="${record.match.document_id}"] .card-prose`,
    );
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(
        out,
        `cards-range-${record === pinned[0] ? "original" : "paraphrase"}.json`,
      ),
      JSON.stringify(cardsRange, null, 2),
    );
    expect(cardsRange.every((r) => r.visible)).toBe(true);
    const text = await preview.innerText();
    expect(text).not.toMatch(/^,?\s*without Git\.?$/);
    await chooseView(page, "Canvas");
    await expect(page.locator(".canvas-document")).toHaveCount(40);
    // At marker scale, the readable group navigator replaces tiny frame headers.
    await page
      .getByRole("navigation", { name: "Folder groups at low zoom" })
      .getByRole("button", { name: /^Symbiknow\s*8 matches$/ })
      .click();
    await expect(
      page.locator(
        `.canvas-document[data-document-id="${record.match.document_id}"]`,
      ),
    ).not.toHaveClass(/overview-card/);
    await expect(page.locator(".zoom-detail")).toBeVisible();
    const canvasPreview = page.locator(
      `.canvas-document[data-document-id="${record.match.document_id}"] .card-prose`,
    );
    await expect(canvasPreview).toContainText("Original bytes");
    await expect(canvasPreview).toContainText("OCFL repository");
    await expect(canvasPreview).toContainText("rocfl 1.7.0");
    await expect(canvasPreview).toContainText("without Git");
    const canvasRange = await visiblePhrases(
      `.canvas-document[data-document-id="${record.match.document_id}"] .card-prose`,
    );
    await fs.writeFile(
      path.join(
        out,
        `canvas-range-${record === pinned[0] ? "original" : "paraphrase"}.json`,
      ),
      JSON.stringify(canvasRange, null, 2),
    );
    expect(canvasRange.every((r) => r.visible)).toBe(true);
    const canvasText = await canvasPreview.innerText();
    await capture(
      page,
      `pinned-canvas-${record === pinned[0] ? "original" : "paraphrase"}`,
    );
    const calls = data.searches.length;
    await chooseView(page, "List");
    expect(data.searches.length).toBe(calls);
    await capture(
      page,
      `pinned-preview-${record === pinned[0] ? "original" : "paraphrase"}`,
      {
        source: record.source_receipt,
        query: record.query,
        cardsPreview: text,
        canvasPreview: canvasText,
        cardsRange,
        canvasRange,
        requests: data.searches,
      },
    );
  });
