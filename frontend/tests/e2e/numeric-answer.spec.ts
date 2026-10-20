import { test, expect } from "@playwright/test";
import { setAnswerChecking } from "../support/ui-controls";

test("numeric answer shows its conversion and source; outage clears it", async ({ page }) => {
  const base = await (await page.request.get("/api/library?limit=100")).json();
  const original = base.documents[0];
  const ref = `${original.document_id}:${original.version}:t0`;
  const text = "Red Cypress backup retention is 9 days.";
  const evidence = { evidence_id: ref, text, basis: "text", provenance: {} };
  const doc = {
    ...original, evidence: [evidence],
    jev: {
      status: "evaluated", label: "direct", policy_label: "direct", coverage: "complete",
      supporting_chunk_ids: [ref],
      evaluated_evidence: [{ chunk_id: ref, text, text_start: 0, text_end: text.length }],
      explanation: "Verified answer: 216 hours. Checked against the supplied documents together.",
    },
  };
  let outage = false;
  await page.route("**/api/search", route => route.fulfill({ json: {
    status: "ok", matches: outage ? [] : [doc],
    evaluation: { status: outage ? "unavailable" : "evaluated" },
    answer: outage ? { status: "unavailable", candidate_count: 2, evaluated_count: 0 } : {
      status: "answered", candidate_count: 2, evaluated_count: 2,
      values: [{ value: "216", unit: "hour", display: "216 hours",
        source: { document_id: doc.document_id, version: doc.version, chunk_id: ref, quote: "9 days", start: 32, end: 38 },
        context_sources: [],
        calculation: { source_value: "9", source_unit: "day", factor_numerator: 24, factor_denominator: 1 },
      }],
    },
  } }));
  await page.route("**/api/document?*", route => route.fulfill({ json: {
    document: doc, current_version: doc.version, organization: doc, evidence: [evidence],
    versions: [{ version: doc.version, filename: doc.filename }], connections: [],
  } }));
  await page.goto("/");
  await setAnswerChecking(page, true);
  const input = page.getByLabel("Search your knowledge");
  await input.fill("How many hours does RC retain backups?");
  await input.press("Enter");
  const answer = page.locator("p.notice").filter({ has: page.getByRole("button", { name: "View source", exact: true }) });
  await expect(answer).toContainText("216 hours");
  await expect(answer).toContainText("Source value: 9 days");
  await answer.getByRole("button", { name: "View source", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Evidence", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  outage = true;
  await input.fill("How many hours does RC retain backups now?");
  await input.press("Enter");
  await expect(answer).toHaveCount(0);
  await expect(page.getByText("Answer checking is unavailable. Retry, or turn off Check answers to browse related files.", { exact: true })).toBeVisible();
});
