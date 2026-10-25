import { expect, test } from "@playwright/test";
import { fixture, audit } from "../support/quality-fixture";

for (const width of [320, 1440]) {
  test(`Jev preserves paginated edits and recovers from failed saves at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await fixture(page);
    const decision = (id: string) => ({
      id, kind: "folder", document_id: id, version: "v1",
      filename: `A very long project reference document ${id}.md`,
      current: "Unfiled", suggested: "Research / Guides", options: ["Research / Guides"],
      reason: "This source describes the research project and its supporting evidence.",
      excerpt: "A synthetic source passage supporting the folder placement.", evidence_ids: [],
    });
    const reads: string[] = [];
    let saved = false;
    let fails = true;
    await page.route(url => url.pathname === "/api/jev-decisions", route => {
      const after = new URL(route.request().url()).searchParams.get("after") || "";
      reads.push(after);
      return route.fulfill({ json: { decisions: after ? saved ? [] : [decision("second")] : [decision("first")], has_more: !after, next_after: after ? "" : "second-page" } });
    });
    const writes: unknown[] = [];
    await page.route(url => url.pathname === "/api/jev-decision", route => {
      writes.push(route.request().postDataJSON());
      if (fails) return route.fulfill({ status: 503, json: { error: "Could not save this decision. Try again." } });
      saved = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.reload();
    const launcher = page.getByRole("button", { name: /^Jev.*decision/ });
    await launcher.click();
    const panel = page.getByRole("dialog", { name: "Jev", exact: true });
    await expect(panel).toContainText("document first.md");
    await panel.getByRole("button", { name: "Next decision", exact: true }).click();
    await expect(panel).toContainText("document second.md");
    await panel.getByRole("button", { name: "Change", exact: true }).click();
    await panel.getByLabel("Choose a folder").fill("Research / Reviewed");
    const before = reads.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => reads.length).toBeGreaterThan(before);
    expect(reads.at(-1)).toBe("second-page");
    await expect(panel.getByLabel("Choose a folder")).toHaveValue("Research / Reviewed");
    await panel.getByRole("button", { name: "Save decision", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("Could not save this decision. Try again.");
    await expect(panel.getByRole("button", { name: "Save decision", exact: true })).toBeEnabled();
    await panel.getByText("See the evidence", { exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("jev-edit-error.png") });
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await audit(page, "Jev decision editor and save error");
    fails = false;
    await panel.getByRole("button", { name: "Save decision", exact: true }).click();
    await expect(panel).toContainText("No decisions left on this page.");
    expect(writes).toEqual([
      { decision_id: "second", action: "change", value: "Research / Reviewed" },
      { decision_id: "second", action: "change", value: "Research / Reviewed" },
    ]);
    await panel.getByRole("button", { name: "Previous decisions", exact: true }).click();
    await expect(panel).toContainText("document first.md");
    await panel.getByRole("button", { name: "Next decision", exact: true }).click();
    await expect(panel).toContainText("No decisions left on this page.");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(launcher).toBeFocused();
    await launcher.click();
    await expect(panel).toContainText("document first.md");
  });
}
