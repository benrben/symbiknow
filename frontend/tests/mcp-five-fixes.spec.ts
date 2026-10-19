import { chooseView } from "./ui-controls";
import {
  setSearchMode,
  setAnswerChecking,
  expectSearchMode,
  expectAnswerChecking,
} from "./ui-controls";
import { test, expect } from "./coverage";
import fs from "node:fs/promises";
import path from "node:path";

const out = path.resolve(
  process.env.SYMBIKNOW_EVIDENCE_DIR
    ? process.env.SYMBIKNOW_EVIDENCE_DIR + "/mcp-five"
    : "../outputs/mcp-five-fixes/screenshots",
);

test("shared evidence coverage and conflict states retain Files/Canvas search and inspector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const examples = [
    {
      name: "Supported view behavior.md",
      coverage: "unknown",
      label: "uncertain",
      support: true,
      conflict: "none_accepted",
    },
    {
      name: "Possible reset conflict.md",
      coverage: "none",
      label: "related",
      support: false,
      conflict: "possible",
    },
    {
      name: "Accepted Git conflict.md",
      coverage: "none",
      label: "related",
      support: false,
      conflict: "accepted",
    },
    {
      name: "Provider outage.md",
      coverage: "unknown",
      label: "uncertain",
      support: false,
      conflict: "none_accepted",
    },
    {
      name: "Current policy disagreement.md",
      coverage: "unknown",
      label: "uncertain",
      support: true,
      conflict: "none_accepted",
      disagreement: true,
    },
  ];
  const docs = examples.map((e, i) => {
    const id = `mcp-five-${i}`;
    const evidence = {
      evidence_id: `${id}:v1:t0`,
      text: "Reset preserves originals and history; views reuse existing results.",
      basis: "text",
      provenance: {},
    };
    return {
      ...base.documents[0],
      document_id: id,
      version: "v1",
      filename: e.name,
      mime_type: "text/markdown",
      size: 256,
      folder: "Symbiknow / Behavior",
      evidence: [evidence],
      jev: {
        status: i === 3 ? "unavailable" : "evaluated",
        label: e.label,
        coverage: e.coverage,
        evidence_presence: e.support ? "supported" : "not_established",
        conflict_status: e.conflict,
        evidence_disagreement: e.disagreement ? "accepted" : "none_detected",
        disagreement_chunk_ids: e.disagreement ? [evidence.evidence_id] : [],
        supporting_chunk_ids: e.support ? [evidence.evidence_id] : [],
        conflicting_chunk_ids:
          e.conflict === "accepted" ? [evidence.evidence_id] : [],
        possible_conflicting_chunk_ids:
          e.conflict === "possible" ? [evidence.evidence_id] : [],
        explanation: e.support
          ? "Jev selected partial; policy returned uncertain. Contains supporting evidence. Coverage not established."
          : "No accepted conflict. Possible conflict requires verification.",
      },
    };
  });
  await page.route("**/api/library?*", (route) =>
    route.fulfill({
      json: {
        ...base,
        documents: docs,
        folders: { "Symbiknow / Behavior": docs.length },
        groups: [],
        total: docs.length,
        processing: false,
      },
    }),
  );
  const requests: any[] = [];
  await page.route("**/api/search", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        status: "ok",
        matches: docs,
        evaluation: { status: "unavailable" },
      },
    });
  });
  await page.route("**/api/document?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    const doc = docs.find((d) => d.document_id === id)!;
    return route.fulfill({
      json: {
        document: doc,
        current_version: "v1",
        organization: doc,
        evidence: doc.evidence,
        versions: [{ version: "v1", filename: doc.filename }],
        connections: [],
      },
    });
  });
  await page.route("**/api/original?*", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body: "# Original current policy\n\nReset preserves originals and history; views reuse existing results.",
    }),
  );
  await page.goto("/");
  await chooseView(page, "List");
  await page
    .getByRole("button", { name: /^Symbiknow \d+$/, exact: true })
    .click();
  await setSearchMode(page, "keyword");
  await setAnswerChecking(page, true);
  await page
    .getByLabel("Search your knowledge")
    .fill("reset versions and views");
  await page.getByLabel("Search your knowledge").press("Enter");
  await expect(page.locator(".file-row")).toHaveCount(5);
  await expect(page.locator(".file-row").nth(0)).toContainText(
    "Supports · Coverage unknown",
  );
  await expect(page.locator(".file-row").nth(1)).toContainText(
    "Possible conflict",
  );
  await expect(page.locator(".file-row").nth(2)).toContainText(
    "Conflicts with premise",
  );
  await expect(page.locator(".file-row").nth(3)).toContainText(
    "Not checked · Provider unavailable",
  );
  await expect(page.locator(".file-row").nth(4)).toContainText(
    "Evidence disagrees",
  );
  const count = requests.length;
  await fs.mkdir(out, { recursive: true });
  await page.screenshot({
    path: path.join(out, "files-coverage-conflicts.png"),
  });
  await page.getByRole("button", { name: "Map", exact: true }).press("Enter");
  await page
    .getByRole("button", { name: "Freeform map", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: "Fit results", exact: true }).click();
  await expect(page.locator(".react-flow__node-document")).toHaveCount(5);
  await expect(
    page
      .locator(".canvas-judgment")
      .filter({ hasText: "Supports · Coverage unknown" }),
  ).toBeVisible();
  await expect(
    page.locator(".canvas-judgment").filter({ hasText: "Possible conflict" }),
  ).toBeVisible();
  await expect(
    page.locator(".canvas-judgment").filter({ hasText: "Evidence disagrees" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(out, "canvas-coverage-conflicts.png"),
  });
  const pane = page.locator(".react-flow__pane");
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 80);
  await page.mouse.up();
  expect(requests.length).toBe(count);
  await expect(page.getByLabel("Search your knowledge")).toHaveValue(
    "reset versions and views",
  );
  await expectSearchMode(page, "keyword");
  await expectAnswerChecking(page, true);
  await chooseView(page, "List");
  expect(requests.length).toBe(count);
  await page
    .locator(".file-row")
    .nth(1)
    .getByRole("button", { name: /^Select / })
    .press("Enter");
  await fs.writeFile(
    path.join(out, "inspector-debug.txt"),
    await page.locator("body").innerText(),
  );
  await expect(page.locator(".inspector")).toContainText(
    "Original current policy",
  );
  await page
    .getByRole("button", { name: "View evidence", exact: true })
    .press("Enter");
  await expect(page.locator(".why-file")).toContainText("Possible conflict");
  await expect(page.locator(".inspector-heading")).toContainText(
    "Possible reset conflict",
  );
  await expect(page.locator(".inspector-meta")).toContainText("v1");
  await expect(page.locator('[id="evidence-mcp-five-1:v1:t0"]')).toContainText(
    "Reset preserves originals and history",
  );
  await page.screenshot({
    path: path.join(out, "inspector-possible-conflict.png"),
  });
  await fs.writeFile(
    path.join(out, "view-state.json"),
    JSON.stringify(
      {
        requests,
        searchCountBeforeViews: count,
        searchCountAfterViews: requests.length,
        documentIDs: docs.map((d) => d.document_id),
      },
      null,
      2,
    ),
  );
});
