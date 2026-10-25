import { expect, test, type Page } from "@playwright/test";
import { fixture, openGuide } from "../support/quality-fixture";

async function agentFixture(page: Page) {
  await fixture(page);
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fixture", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            id: "fixture",
            name: "Fixture model",
            default: true,
            efforts: ["low"],
            default_effort: "low",
          },
        ],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "context-fixture",
        token: "fixture",
        provider: "Fixture agent",
      },
    }),
  );
  const messages: Record<string, any>[] = [],
    history: Record<string, unknown>[] = [];
  let seq = 0,
    run = 0,
    socket: any,
    connections = 0;
  const emit = (type: string, extra: Record<string, unknown> = {}) => {
    const value = {
      type,
      seq: ++seq,
      session_id: "context-fixture",
      run_id: `run-${run}`,
      ...extra,
    };
    history.push(value);
    socket.send(JSON.stringify(value));
  };
  await page.routeWebSocket("**/api/agent-chat/context-fixture", (ws) => {
    socket = ws;
    connections++;
    ws.onMessage((data) => {
      const value = JSON.parse(String(data));
      messages.push(value);
      if (value.type === "send") {
        run++;
        emit("run_started", { message: value.message });
      }
      if (value.type === "cancel")
        emit("run_finished", { status: "cancelled" });
      if (value.type === "approval")
        emit(value.approve ? "tool_call_approved" : "tool_call_denied", {
          id: value.id,
        });
      if (value.type === "replay" && connections > 1)
        for (const event of history.filter(
          (event) => Number(event.seq) >= value.after,
        ))
          ws.send(JSON.stringify(event));
    });
  });
  return {
    messages,
    emit,
    disconnect: () => socket.close({ code: 1012 }),
    connections: () => connections,
  };
}

async function start(page: Page) {
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByLabel("Message Fixture agent")).toBeVisible();
}

test("inspect exact metadata before Start; narrow and clear every outbound context including command results", async ({
  page,
}) => {
  const agent = await agentFixture(page);
  await openGuide(page);
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  const review = page.locator(".assistant-context-review");
  await expect(review).toContainText("Context for this chat");
  await review.locator("> summary").click();
  await expect(review).toContainText("Guide.md · v2");
  await expect(review).toContainText("quality-0");
  await expect(review).toContainText("60 files loaded");
  await expect(review).toContainText(
    "No file contents or evidence passages are attached",
  );
  for (const name of [
    "Selected files",
    "Folder, topic and project scope",
    "Query and loaded results",
  ])
    await review.getByRole("checkbox", { name, exact: true }).uncheck();
  await start(page);
  await expect
    .poll(
      () =>
        agent.messages.filter((message) => message.type === "context_update")
          .length,
    )
    .toBeGreaterThan(0);
  expect(
    agent.messages.find((message) => message.type === "context_update"),
  ).toMatchObject({
    open_document: { document_id: "quality-0", version: "v2" },
  });
  await page
    .getByLabel("Message Fixture agent")
    .fill("Inspect this exact file");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = agent.messages.find(
    (message) => message.type === "send",
  )!.context;
  expect(Object.keys(sent).sort()).toEqual(
    ["context_policy", "open_document", "reader_expanded", "reader_tab"].sort(),
  );
  await review.getByRole("button", { name: "Clear chat context" }).click();
  await expect(review).toContainText("No current view metadata is shared");
  await expect
    .poll(
      () =>
        agent.messages
          .filter((message) => message.type === "context_update")
          .at(-1)?.open_document,
    )
    .toBeUndefined();
  agent.emit("ui_command", {
    id: "filtered-command",
    name: "close_document",
    args: {},
    expires_at: Date.now() + 10000,
  });
  await expect
    .poll(
      () =>
        agent.messages.find((message) => message.type === "ui_result")?.result
          ?.completed,
    )
    .toBe(true);
  expect(
    agent.messages.find((message) => message.type === "ui_result")!.result
      .state,
  ).toEqual({
    context_policy: {
      open_document: false,
      selection: false,
      scope: false,
      results: false,
    },
  });
  await agent.disconnect();
  await expect.poll(agent.connections).toBe(2);
  await expect
    .poll(
      () =>
        agent.messages.filter((message) => message.type === "replay").length,
    )
    .toBe(2);
  expect(
    agent.messages
      .filter((message) => message.type === "context_update")
      .at(-1),
  ).toEqual({
    type: "context_update",
    context_policy: {
      open_document: false,
      selection: false,
      scope: false,
      results: false,
    },
  });
});

test("context controls remain keyboard reachable at 768px and navigation changes are visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 800 });
  const agent = await agentFixture(page);
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  const review = page.locator(".assistant-context-review");
  await review.locator("> summary").click();
  const include = review.getByRole("checkbox", {
    name: "Query and loaded results",
  });
  await include.focus();
  await page.keyboard.press("Space");
  await expect(include).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(include).toBeChecked();
  await start(page);
  await page.getByLabel("Message Fixture agent").blur();
  agent.emit("ui_command", {
    id: "navigate",
    name: "navigate",
    args: { scope: "recent" },
    expires_at: Date.now() + 10000,
  });
  await expect
    .poll(
      () => agent.messages.find((message) => message.type === "ui_result")?.ok,
    )
    .toBe(true);
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await expect(review).toContainText("Recent");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("ordered approval journey shows exact identities, denial and saved versus searchable receipts", async ({
  page,
}) => {
  const agent = await agentFixture(page);
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await start(page);
  await page.locator(".assistant-context-review > summary").click();
  await page.getByLabel("Message Fixture agent").fill("Propose a safe update");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  agent.emit("text_delta", { text: "First I will preview the exact change." });
  const proposal = (id: string) => {
    agent.emit("tool_call_started", { id, name: "upload", kind: "approval" });
    agent.emit("tool_call_args", {
      id,
      args: {
        files: [
          {
            document_id: "exact-file",
            expected_version: "v7",
            request_id: "same-stable-request",
          },
        ],
      },
    });
    agent.emit("tool_call_awaiting_approval", {
      id,
      preview: {
        files: [
          { filename: "Report.md", document_id: "exact-file", version: "v7" },
        ],
        warning: "Save a new version",
      },
    });
  };
  proposal("denied");
  await expect(page.getByLabel("Review proposed change")).toContainText(
    "Report.md v7",
  );
  await expect(page.getByLabel("Review proposed change")).toContainText(
    "exact-file",
  );
  await expect(page.getByLabel("Review proposed change")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    agent.messages.filter((message) => message.type === "approval"),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    page.getByText("You denied this. The agent was told."),
  ).toBeVisible();
  proposal("approved");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect(
    agent.messages
      .filter((message) => message.type === "approval")
      .map((message) => message.approve),
  ).toEqual([false, true]);
  agent.emit("tool_call_error", {
    id: "approved",
    message: "Some files need retry; inspect stored receipts first.",
    result: {
      ok: false,
      complete: false,
      files: [
        {
          filename: "Report.md",
          document_id: "exact-file",
          version: "v8",
          stored: true,
          searchable: false,
          indexing_status: "pending",
          request_id: "same-stable-request",
        },
        {
          filename: "Retry.md",
          document_id: "not-saved",
          stored: false,
          searchable: false,
          error: "Fixture storage failure",
        },
      ],
    },
  });
  agent.emit("run_finished", { status: "completed" });
  const receipt = page.getByRole("region", { name: "Transfer receipt" });
  await expect(receipt).toContainText("exact-file · v8");
  await expect(receipt).toContainText(
    "Original saved · Search: Indexing queued",
  );
  await expect(receipt).toContainText("same-stable-request");
  await expect(receipt).toContainText("Original not saved");
  await expect(receipt).toContainText("Some files need attention");
  await expect(page.locator(".assistant-run .assistant-answer")).toHaveText(
    "First I will preview the exact change.",
  );
  expect(
    await page.locator(".assistant-run").evaluate((element) =>
      Array.from(element.children)
        .filter((child) =>
          child.matches(".assistant-answer,.assistant-tool-group"),
        )
        .map((child) => child.className),
    ),
  ).toEqual(["assistant-answer", "assistant-tool-group"]);
});

test("Stop, explicit Continue/Retry and reconnect preserve completed steps without resending approval", async ({
  page,
}) => {
  const agent = await agentFixture(page);
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await start(page);
  await page.locator(".assistant-context-review > summary").click();
  await page.getByLabel("Message Fixture agent").fill("Find the report");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  agent.emit("tool_call_started", {
    id: "read",
    name: "read_document",
    kind: "server",
  });
  agent.emit("tool_call_result", {
    id: "read",
    result: {
      document: {
        document_id: "quality-0",
        version: "v2",
        filename: "Guide.md",
      },
      characters_read: 42,
      has_more: false,
    },
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Continue stopped request" }).click();
  await expect
    .poll(
      () => agent.messages.filter((message) => message.type === "send").length,
    )
    .toBe(2);
  expect(
    agent.messages.filter((message) => message.type === "send")[1].message,
  ).toContain("Check the completed tool receipts");
  agent.emit("run_error", { message: "Fixture provider interruption" });
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect
    .poll(
      () => agent.messages.filter((message) => message.type === "send").length,
    )
    .toBe(3);
  agent.emit("text_delta", { text: "Recovered answer." });
  agent.emit("run_finished", { status: "completed" });
  await agent.disconnect();
  await expect.poll(agent.connections).toBe(2);
  await expect
    .poll(
      () =>
        agent.messages.filter((message) => message.type === "replay").length,
    )
    .toBe(2);
  await expect(
    page.getByText("Recovered answer.", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("42 characters read · End of extracted text"),
  ).toHaveCount(1);
  expect(
    agent.messages.filter((message) => message.type === "approval"),
  ).toHaveLength(0);
});

test("agent evidence navigation keeps exact file/version/evidence IDs and reports stale citations", async ({
  page,
}) => {
  const agent = await agentFixture(page);
  const requests: URL[] = [];
  let stale = false;
  await page.route("**/api/agent-document?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    return stale
      ? route.fulfill({
          status: 409,
          json: { error: "Evidence no longer current" },
        })
      : route.fulfill({
          json: {
            document_id: "quality-0",
            version: "v2",
            filename: "Guide.md",
            mime_type: "text/markdown",
            evidence: [
              {
                evidence_id: "quality-0:v2:t0",
                text: "Original source evidence",
                provenance: {},
              },
            ],
          },
        });
  });
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await start(page);
  await page.locator(".assistant-context-review > summary").click();
  await page.getByLabel("Message Fixture agent").fill("Show its citation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  agent.emit("tool_call_started", {
    id: "citation",
    name: "list_jev_decisions",
    kind: "server",
  });
  agent.emit("tool_call_result", {
    id: "citation",
    result: {
      decisions: [
        {
          id: "decision",
          document_id: "quality-0",
          version: "v2",
          filename: "Guide.md",
          evidence_ids: ["quality-0:v2:t0"],
          excerpt: "Original source evidence",
        },
      ],
    },
  });
  agent.emit("run_finished", { status: "completed" });
  await page
    .getByRole("button", { name: "Show evidence", exact: true })
    .click();
  await expect(page.locator('[data-agent-highlight="true"]')).toBeVisible();
  expect(Object.fromEntries(requests[0].searchParams)).toEqual({
    id: "quality-0",
    version: "v2",
    evidence: "quality-0:v2:t0",
  });
  stale = true;
  await page
    .getByRole("button", { name: "Show evidence", exact: true })
    .click();
  await expect(page.locator(".assistant-status")).toContainText(
    "document_changed_or_deleted",
  );
});
