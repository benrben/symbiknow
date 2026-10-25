// Opt-in real-provider browser check. Start the isolated ui_fixture.py on 8878.
// Never point this script at a live library: it approves a synthetic file move.
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
    const selectedModel = provider === "Claude Code" ? "sonnet" : "gpt-6-luna";
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      baseURL: "http://127.0.0.1:8878",
    });
    const events = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        try {
          const e = JSON.parse(String(payload));
          events.push({
            type: e.type,
            name: e.name,
            id: e.id,
            status: e.status,
            model: e.model,
          });
        } catch {}
      }),
    );
    await page.goto("/");
    const library = await (await page.request.get("/api/library")).json();
    const doc = library.documents.find(
      (d) => d.filename === "storage-decisions.md",
    );
    if (!doc) throw new Error("Expected isolated browser fixture");
    await page
      .getByRole("button", { name: "Ask an agent", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^${provider}`) })
      .click();
    await expect(page.getByLabel("Model", { exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await page.getByLabel("Model", { exact: true }).selectOption(selectedModel);
    await page.getByLabel("Reasoning effort").selectOption("low");
    await page.getByRole("button", { name: "Start chat", exact: true }).click();
    const message = page.getByLabel(`Message ${provider}`);
    await expect(message).toBeVisible({ timeout: 60000 });
    await message.fill(
      'Use search with mode keyword, query "Each update is saved", evaluate false. Then call highlight_evidence to open the first matching passage in storage-decisions.md. Keep your answer short.',
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator('[data-agent-highlight="true"]')).toBeVisible({
      timeout: 180000,
    });
    await expect(
      page.getByText(`Opened by ${provider}`, { exact: false }),
    ).toBeVisible();
    await expect
      .poll(() => events.some((e) => e.type === "run_finished"), {
        timeout: 180000,
      })
      .toBe(true);
    if (
      !events.some((e) => e.type === "tool_call_started" && e.name === "search")
    )
      throw new Error("Search not called");
    if (events.some((e) => e.type === "run_error"))
      throw new Error("Provider run failed");
    const passage = await page
      .locator('[data-agent-highlight="true"]')
      .boundingBox();
    const panel = await page.locator(".assistant-panel").boundingBox();
    if (passage.x < panel.x + panel.width)
      throw new Error("Chat obscures evidence");
    await page.screenshot({
      path: `artifacts/agents/live-${provider.replaceAll(" ", "-").toLowerCase()}.png`,
    });
    await page
      .locator(".assistant-opened")
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(page.locator(".assistant-opened")).toHaveCount(0);
    const target = `Runtime ${provider}`;
    await message.fill(
      `Use move_documents to move document ${doc.document_id}, expected_version ${doc.version}, to folder "${target}". I will approve in the app.`,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible({ timeout: 180000 });
    const before = await (await page.request.get("/api/library")).json();
    if (
      before.documents.find((d) => d.document_id === doc.document_id).folder ===
      target
    )
      throw new Error("Write happened before approval");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect
      .poll(
        async () => {
          const current = await (await page.request.get("/api/library")).json();
          return current.documents.find(
            (d) => d.document_id === doc.document_id,
          ).folder;
        },
        { timeout: 30000 },
      )
      .toBe(target);
    await expect
      .poll(() => events.filter((e) => e.type === "run_finished").length, {
        timeout: 180000,
      })
      .toBeGreaterThanOrEqual(3);
    if (events.some((e) => e.type === "run_error"))
      throw new Error("Approval follow-up failed");
    report.push({
      provider,
      selected_model: selectedModel,
      reported_models: [...new Set(events.map((e) => e.model).filter(Boolean))],
      search: true,
      evidence_highlight: true,
      opened_label: true,
      back: true,
      approval_guard: true,
      approved_move: true,
      streamed: events.some((e) => e.type === "text_delta"),
    });
    await page.getByRole("button", { name: "Close agent chat" }).click();
    await page.close();
    await writeFile(
      "artifacts/agents/live-browser-check.json",
      JSON.stringify(report, null, 2),
    );
    console.log(`${provider}: browser flow passed`);
  }
} finally {
  await browser.close();
}
