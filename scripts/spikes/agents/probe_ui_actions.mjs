// Opt-in live CLI check against the synthetic ui_fixture.py on port 8878 only.
import {
  chromium,
  expect,
} from "../../../frontend/node_modules/@playwright/test/index.mjs";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const report = [];
try {
  for (const provider of ["Claude Code", "Codex"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      baseURL: "http://127.0.0.1:8878",
    });
    const events = [],
      receipts = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          events.push(JSON.parse(String(payload)));
        } catch {}
      });
      socket.on("framesent", ({ payload }) => {
        try {
          const m = JSON.parse(String(payload));
          if (m.type === "ui_result") receipts.push(m);
        } catch {}
      });
    });
    await page.goto("/");
    const library = await (await page.request.get("/api/library")).json();
    if (
      !library.documents.some((d) => d.filename === "storage-decisions.md") ||
      library.total !== 7
    )
      throw Error("Expected isolated fixture");
    await page
      .getByRole("button", { name: "Ask an agent", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^${provider}`) })
      .click();
    await expect(page.getByLabel("Model", { exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await page
      .getByLabel("Model", { exact: true })
      .selectOption(provider === "Claude Code" ? "sonnet" : "gpt-6-luna");
    await page.getByLabel("Reasoning effort").selectOption("low");
    await page.getByRole("button", { name: "Start chat", exact: true }).click();
    const composer = page.getByLabel(`Message ${provider}`);
    await expect(composer).toBeVisible({ timeout: 60000 });
    await composer.fill(
      'Please operate the app UI. In order: use show_search with mode semantic and query "Each update is saved"; switch to grid sorted by filename ascending; open storage-decisions.md using its current ID/version from get_ui_context or the show_search receipt; switch its reader to Details and expand it. Perform each action sequentially and verify the returned state. Keep your final answer short.',
    );
    await composer.press("Enter");
    await expect
      .poll(
        () =>
          events.some(
            (e) => e.type === "run_finished" || e.type === "run_error",
          ),
        { timeout: 180000 },
      )
      .toBe(true);
    if (events.some((e) => e.type === "run_error"))
      throw Error(JSON.stringify(events.filter((e) => e.type === "run_error")));
    for (const name of [
      "show_search",
      "set_library_view",
      "open_document",
      "set_reader_view",
    ]) {
      if (
        !receipts.some(
          (r) => r.ok && r.result?.action === name && r.result.completed,
        )
      )
        throw Error(`Missing completed ${name}: ${JSON.stringify(receipts)}`);
    }
    await expect(page.getByLabel("Search your knowledge")).toHaveValue(
      "Each update is saved",
    );
    await expect(
      page.getByRole("tab", { name: "Details", exact: true }),
    ).toHaveAttribute("data-state", "active");
    await expect(
      page.getByRole("button", { name: "Split view", exact: true }),
    ).toBeVisible();
    const screenshot = `artifacts/agents/compact-ui-${provider.replaceAll(" ", "-").toLowerCase()}.png`;
    await page.screenshot({ path: screenshot });
    report.push({
      provider,
      enter_submission: true,
      panel_width: (await page.locator(".assistant-panel").boundingBox()).width,
      actions: receipts.map((r) => ({
        ok: r.ok,
        action: r.result?.action,
        completed: r.result?.completed,
        reason: r.result?.reason,
      })),
      final_state: receipts.at(-1)?.result?.state,
      screenshot,
    });
    await page
      .getByRole("button", { name: "New chat and choose model" })
      .click();
    await page.close();
    await writeFile(
      "artifacts/agents/live-ui-actions.json",
      JSON.stringify(report, null, 2),
    );
    console.log(`${provider}: actual UI actions passed`);
  }
} finally {
  await browser.close();
}
