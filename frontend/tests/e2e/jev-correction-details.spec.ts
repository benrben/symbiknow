import { test, expect } from "../support/coverage";
import type { Doc, Library } from "../../src/shared/api/client";

const sourceId = "jev-correction-source";
const targetId = "jev-correction-target";
const sourceClaim = "A 30-day credit window applies to annual subscriptions.";
const targetClaim = "Annual renewals qualify for credits within 30 days.";
const extraSourceClaim = "A separate signed addendum confirms the credit exception.";
const extraTargetClaim = "The renewal record points to the signed credit addendum.";
const source: Doc = {
  document_id: sourceId,
  version: "v1",
  filename: "Subscription policy.txt",
  mime_type: "text/plain",
  status: "indexed",
  folder: "Personal",
  groups: [],
};
const target: Doc = {
  document_id: targetId,
  version: "v1",
  filename: "Renewal notes.txt",
  mime_type: "text/plain",
  status: "indexed",
  folder: "Personal",
  groups: [],
};
const connection = {
  document_id: targetId,
  version: "v1",
  source_version: "v1",
  source_document_id: sourceId,
  source_filename: source.filename,
  target_filename: target.filename,
  relation: "supports",
  source_chunk_id: "source-chunk",
  target_chunk_id: "target-chunk",
  proof: {
    source: { text: sourceClaim },
    target: { text: targetClaim },
  },
};

const connectionWithSupplementalEvidence = {
  ...connection,
  proof: undefined,
  additional_evidence: [{
    proof: {
      source: { text: extraSourceClaim },
      target: { text: extraTargetClaim },
    },
  }],
};

async function installFixture(page: import("@playwright/test").Page, link: typeof connection | typeof connectionWithSupplementalEvidence) {
  const linkReads: URLSearchParams[] = [];
  const library: Library = {
    library_id: "jev-correction-ui-fixture",
    documents: [source, target],
    total: 2,
    library_total: 2,
    has_more: false,
    folders: { Personal: 2 },
    groups: [],
    processing: false,
    max_file_bytes: 10 * 1024 * 1024,
    max_chunk_bytes: 1024 * 1024,
    index_revision: "fixture-index-v1",
    organization_revision: "fixture-organization-v1",
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const action = url.pathname.split("/").at(-1);
    if (action === "library") return route.fulfill({ json: library });
    if (action === "progress") return route.fulfill({ json: {
      index_revision: library.index_revision,
      organization_revision: library.organization_revision,
      processing: false,
    } });
    if (action === "jev-decisions") return route.fulfill({ json: { decisions: [], has_more: false } });
    if (action === "document") {
      const id = url.searchParams.get("id");
      const document = id === targetId ? target : source;
      return route.fulfill({ json: {
        document,
        current_version: "v1",
        organization: { folder: "Personal", groups: [], organization_status: "evaluated" },
        organization_review: {
          origin: "manual",
          organization_reason: "An earlier placement was corrected.",
          effective_owner: { name: "Crazyidea" },
          automatic_owner_suggestion: { name: "Symbiknow" },
          manual_folder_override: { folder: "Personal" },
          correction_provenance: [{ reason: "The source belongs to the Crazyidea project." }],
          evidence_ids: [],
        },
        evidence: [],
        connections: id === sourceId ? [link] : [],
        versions: [document],
      } });
    }
    if (action === "link") {
      linkReads.push(url.searchParams);
      return route.fulfill({ json: {
        source: [{ evidence_id: "source-passage", text: `Policy excerpt: ${sourceClaim}`, provenance: {} }],
        target: [{ evidence_id: "target-passage", text: `Renewal record: ${targetClaim}`, provenance: {} }],
      } });
    }
    if (action === "original") return route.fulfill({ contentType: "text/plain", body: "Fixture original text." });
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${action}` } });
  });
  return linkReads;
}

async function openConnection(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");
  await page.getByRole("button", { name: "Select Subscription policy.txt", exact: true }).dblclick();
  const inspector = page.locator(".inspector");
  await inspector.getByRole("tab", { name: "Connections", exact: true }).click();
  await inspector.getByRole("button", { name: /Subscription policy\.txt.*Renewal notes\.txt/ }).click();
  return inspector;
}

test("Details separates project ownership from folder correction and connections show exact claims", async ({ page }) => {
  await installFixture(page, connection);

  await page.goto("/");
  await page.getByLabel("File layout").selectOption("list");
  await page.getByRole("button", { name: "Select Subscription policy.txt", exact: true }).dblclick();

  const inspector = page.locator(".inspector");
  await inspector.getByRole("tab", { name: "Details", exact: true }).click();
  const whyFolder = inspector.locator("details.why-here");
  await whyFolder.locator("summary").click();
  await expect(whyFolder).toContainText("Effective project: Crazyidea");
  await expect(whyFolder).toContainText("Automatic project suggestion: Symbiknow");
  await expect(whyFolder).toContainText("Manual folder placement: Personal");
  await expect(whyFolder).toContainText("Project correction reason: The source belongs to the Crazyidea project.");

  await inspector.getByRole("tab", { name: "Connections", exact: true }).click();
  await inspector.getByRole("button", { name: /Subscription policy\.txt.*Renewal notes\.txt/ }).click();
  const claims = inspector.getByText("Claims used for this connection");
  await claims.click();
  const proof = inspector.locator("details.link-claim-proof");
  await expect(proof).toContainText(sourceClaim);
  await expect(proof).toContainText(targetClaim);
});

test("a supplementary checked reference keeps the original connection anchors", async ({ page }) => {
  const linkReads = await installFixture(page, connectionWithSupplementalEvidence);
  const inspector = await openConnection(page);
  const selectedLink = inspector.locator(".link-evidence");
  await expect(selectedLink.getByRole("heading", { name: "Supports", exact: true })).toBeVisible();
  await expect(selectedLink).toContainText(
    "Subscription policy.txt (v1) → Renewal notes.txt (v1)",
  );

  const supplemental = inspector.locator("details.link-claim-proof");
  await expect(supplemental.locator("summary")).toHaveText("Additional checked reference");
  await expect(supplemental).toContainText(extraSourceClaim);
  await expect(supplemental).toContainText(extraTargetClaim);
  await expect(supplemental).not.toContainText(sourceClaim);
  await expect(supplemental).not.toContainText(targetClaim);
  await expect.poll(() => linkReads.length).toBe(1);
  expect(Object.fromEntries(linkReads[0].entries())).toMatchObject({
    id: sourceId,
    version: "v1",
    target: targetId,
    target_version: "v1",
    source_chunk: "source-chunk",
    target_chunk: "target-chunk",
  });
});
