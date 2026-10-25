import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent-models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            id: "fast",
            name: "Fast model",
            description: "Quick answers",
            default: true,
            efforts: ["low", "high"],
            default_effort: "low",
          },
          {
            id: "capable",
            name: "Capable model",
            description: "Complex tasks",
            default: false,
            efforts: ["medium", "high"],
            default_effort: "medium",
          },
        ],
      },
    }),
  );
});

test("chat streaming, unknown cards, approval keyboard safety, Stop and denied state", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "fake",
            name: "Fixture agent",
            available: true,
            installed: true,
            version: "Fixture",
            reason: "Test only",
            untested: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "fixture",
        token: "test-token",
        provider: "Fixture agent",
      },
    }),
  );
  let seq = 0,
    approvals = 0;
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          type,
          seq: ++seq,
          session_id: "fixture",
          run_id: "run",
          ...extra,
        }),
      );
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "send") {
        emit("run_started", { message: message.message });
        for (const text of ["A ", "streamed ", "answer."])
          emit("text_delta", { text });
        emit("tool_call_started", {
          id: "new",
          name: "future_tool",
          kind: "server",
        });
        emit("tool_call_error", { id: "new", message: "Fixture error" });
        emit("tool_call_started", {
          id: "write",
          name: "remove_file",
          kind: "approval",
        });
        emit("tool_call_awaiting_approval", {
          id: "write",
          preview: {
            operation: "remove_file",
            warning: "Permanently delete all versions",
            files: [{ filename: "Example.txt", version: "v1" }],
          },
        });
      } else if (message.type === "approval") {
        approvals++;
        emit(message.approve ? "tool_call_approved" : "tool_call_denied", {
          id: message.id,
        });
      } else if (message.type === "cancel")
        emit("run_finished", { status: "cancelled" });
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: /Fixture agent/ }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  const message = page.getByLabel("Message Fixture agent");
  await message.fill("Find something");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("A streamed answer.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("future tool", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixture error", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Review proposed change")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(approvals).toBe(0);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    page.getByText("You denied this. The agent was told."),
  ).toBeVisible();
  expect(approvals).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Stopped.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close agent chat" }).click();
  await expect(
    page.getByRole("button", { name: "Ask an agent", exact: true }),
  ).toBeFocused();
});

test("browser commands respect typing and do not render agent markup", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fake", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "fixture",
        token: "test-token",
        provider: "Fixture agent",
      },
    }),
  );
  let sendCommand: () => void = () => {},
    result: Record<string, unknown> | undefined;
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    sendCommand = () =>
      ws.send(
        JSON.stringify({
          type: "ui_command",
          seq: 1,
          session_id: "fixture",
          run_id: "r",
          id: "command",
          name: "navigate",
          args: { folder: "Secret" },
          expires_at: Date.now() + 10000,
        }),
      );
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "ui_result") result = message;
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: /Fixture agent/ }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Fixture agent").fill("Unsent message");
  sendCommand();
  await expect.poll(() => result?.ok).toBe(false);
  expect(result?.result).toMatchObject({ reason: "user_busy" });
  await expect(page.getByLabel("Message Fixture agent")).toHaveValue(
    "Unsent message",
  );
  await expect(page.getByLabel("Message Fixture agent")).toBeFocused();
});

test("Antigravity CLI starts and streams chat separately from Gemini", async ({
  page,
}) => {
  const providerRequests: Array<{ path: string; provider?: string }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/agent-models" || url.pathname === "/api/agent-sessions") {
      const body = request.postDataJSON() as { provider?: string } | null;
      providerRequests.push({ path: url.pathname, provider: body?.provider });
    }
  });
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "gemini",
            name: "Gemini CLI",
            available: false,
            installed: false,
            reason: "Gemini support is deferred.",
          },
          {
            id: "antigravity",
            name: "Antigravity CLI",
            available: true,
            installed: true,
            version: "1.4.6",
            reason: "",
          },
        ],
      },
    }),
  );
  await page.route("**/api/agent-models", (route) => route.fulfill({ json: {
    models: [{ id: "gemini-3.8-high", name: "Gemini 3.8 High", default: true, efforts: [] }],
  } }));
  await page.route("**/api/agent-sessions", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ provider: "antigravity", model: "gemini-3.8-high" });
    return route.fulfill({ json: { session_id: "fixture", token: "test-token", provider: "Antigravity CLI" } });
  });
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "send") return;
      for (const [index, event] of [
        { type: "run_started", message: message.message },
        { type: "text_delta", text: "Antigravity chat connected." },
        { type: "run_finished", status: "completed" },
      ].entries()) ws.send(JSON.stringify({ ...event, seq: index + 1, session_id: "fixture", run_id: "agy-run" }));
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();

  const gemini = page.getByRole("button", { name: /Gemini CLI/ });
  const antigravity = page.getByRole("button", { name: /Antigravity CLI/ });
  // Unavailable agents are grouped and collapsed.
  await page.locator(".assistant-unavailable > summary").click();
  await expect(gemini).toBeVisible();
  await expect(antigravity).toBeVisible();
  await expect(gemini).toBeDisabled();
  await expect(antigravity).toBeEnabled();
  await expect(antigravity).toHaveAttribute("title", "1.4.6");
  await antigravity.click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gemini-3.8-high");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Antigravity CLI").fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Antigravity chat connected.", { exact: true })).toBeVisible();
  expect(providerRequests.some((request) => request.path === "/api/agent-models")).toBe(true);
  expect(providerRequests.some((request) => request.path === "/api/agent-sessions")).toBe(true);
  expect(providerRequests.every((request) => request.provider === "antigravity")).toBe(true);
});

test("agent opens pinned evidence and Back restores the prior view", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fake", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "fixture",
        token: "test-token",
        provider: "Fixture agent",
      },
    }),
  );
  let seq = 0,
    sendCommand: (
      name: string,
      args: Record<string, unknown>,
    ) => void = () => {};
  let result: Record<string, unknown> | undefined;
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    sendCommand = (name, args) => {
      result = undefined;
      ws.send(
        JSON.stringify({
          type: "ui_command",
          seq: ++seq,
          session_id: "fixture",
          run_id: "r",
          id: `command${seq}`,
          name,
          args,
          expires_at: Date.now() + 10000,
        }),
      );
    };
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "ui_result") result = message;
    });
  });
  await page.goto("/");
  const library = await (await page.request.get("/api/library")).json();
  const doc = library.documents.find(
    (doc: { filename: string }) => doc.filename === "storage-decisions.md",
  );
  const card = await (
    await page.request.get(
      `/api/card?id=${doc.document_id}&version=${doc.version}`,
    )
  ).json();
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: /Fixture agent/ }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Fixture agent").blur();
  sendCommand("highlight_evidence", {
    document_id: doc.document_id,
    version: doc.version,
    evidence_id: card.evidence[0].evidence_id,
  });
  await expect.poll(() => result?.ok).toBe(true);
  await expect(
    page.getByText("Opened by Fixture agent", { exact: false }),
  ).toBeVisible();
  await expect(page.locator('[data-agent-highlight="true"]')).toBeVisible();
  const passage = await page
    .locator('[data-agent-highlight="true"]')
    .boundingBox();
  const panel = await page.locator(".assistant-panel").boundingBox();
  // The docked chat sits beside the reader; it must not cover the passage.
  expect(passage!.x + passage!.width).toBeLessThanOrEqual(panel!.x);
  await page.screenshot({
    path: new URL(
      "../../../artifacts/agents/assistant-evidence.png",
      import.meta.url,
    ).pathname,
  });
  await page
    .locator(".assistant-opened")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect(page.locator(".assistant-opened")).toHaveCount(0);
});

test("reconnect replays from the last sequence without duplicating the answer", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fake", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "fixture",
        token: "test-token",
        provider: "Fixture agent",
      },
    }),
  );
  let connections = 0,
    reconnectAfter = -1,
    disconnect: () => Promise<void> = async () => {};
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    const connection = ++connections;
    disconnect = () => ws.close({ code: 1012 });
    const emit = (type: string, seq: number, extra = {}) =>
      ws.send(
        JSON.stringify({
          type,
          seq,
          session_id: "fixture",
          run_id: "r",
          ...extra,
        }),
      );
    ws.onMessage((data) => {
      const value = JSON.parse(String(data));
      if (value.type !== "replay") return;
      if (connection === 1) {
        emit("run_started", 1, { message: "Hello" });
        emit("text_delta", 2, { text: "Hello " });
      } else {
        reconnectAfter = value.after;
        emit("text_delta", 2, { text: "Hello " });
        emit("text_delta", 3, { text: "again" });
        emit("run_finished", 4, { status: "completed" });
      }
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: /Fixture agent/ }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.locator(".assistant-answer")).toHaveText("Hello");
  await disconnect();
  await expect(page.locator(".assistant-answer")).toHaveText("Hello again");
  expect(reconnectAfter).toBe(2);
  expect(connections).toBe(2);
});

test("model and effort selection, ordered activity, safe Markdown and new-chat preferences", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "fake",
            name: "Fixture agent",
            available: true,
            installed: true,
          },
        ],
      },
    }),
  );
  let selected: Record<string, unknown> = {};
  await page.route("**/api/agent-sessions", (route) => {
    selected = route.request().postDataJSON();
    return route.fulfill({
      json: {
        session_id: "fixture",
        token: "test-token",
        provider: "Fixture agent",
        model: selected.model,
        model_name: "Capable model",
        effort: selected.effort,
      },
    });
  });
  let seq = 0;
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          type,
          seq: ++seq,
          session_id: "fixture",
          run_id: "r",
          timestamp: Date.now(),
          ...extra,
        }),
      );
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "send") return;
      emit("run_started", { message: message.message });
      emit("text_delta", {
        text: "I’ll search your library for **version history**.\n\n",
      });
      emit("tool_call_started", {
        id: "search",
        name: "search",
        kind: "server",
      });
      emit("tool_call_args", {
        id: "search",
        args: { query: "version history", mode: "keyword" },
      });
      emit("tool_call_result", {
        id: "search",
        result: {
          matches: [
            {
              filename: "storage-decisions.md",
              excerpt:
                "Each update is saved as a new version, preserving the original bytes.",
            },
          ],
        },
      });
      emit("text_delta", {
        text: "### What I found\n\nUpdates preserve the **original bytes**.\n\n| Action | Result |\n| --- | --- |\n| Update a file | New version |\n\n<script>window.bad=true</script>\n\n![tracker](https://example.invalid/tracker.png) [unsafe](javascript:alert(1))",
      });
      emit("run_metadata", { model: "native-capable-v2" });
      emit("run_finished", { status: "completed" });
    });
  });
  let imageRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("tracker.png")) imageRequests++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("capable");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("medium");
  await page.getByLabel("Reasoning effort").selectOption("high");
  await page.screenshot({ path: "../artifacts/agents/model-picker.png" });
  expect(
    (await new AxeBuilder({ page }).include(".assistant-panel").analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  expect(selected).toEqual({
    provider: "fake",
    model: "capable",
    effort: "high",
  });
  await expect(page.locator(".assistant-heading")).toContainText(
    "Capable model · high effort",
  );
  const composer = page.getByLabel("Message Fixture agent");
  await composer.fill("How does version history work?");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("How does version history work?\n");
  await composer.press("Enter");
  await expect(
    page.getByRole("heading", { name: "What I found" }),
  ).toBeVisible();
  await expect(page.locator(".assistant-answer table")).toBeVisible();
  expect(
    await page.locator(".assistant-run").evaluate((el) =>
      Array.from(el.children)
        .filter((child) =>
          child.matches(".assistant-answer,.assistant-tool-group"),
        )
        .map((child) => child.className),
    ),
  ).toEqual(["assistant-answer", "assistant-tool-group", "assistant-answer"]);
  await expect(
    page.locator(
      ".assistant-answer img,.assistant-answer script,.assistant-answer a",
    ),
  ).toHaveCount(0);
  expect(imageRequests).toBe(0);
  await expect(page.locator(".assistant-model-used")).toHaveText(
    "Model: native-capable-v2",
  );
  await page.getByRole("button", { name: "1 step Search library" }).click();
  await expect(page.locator(".assistant-tool")).toHaveCount(0);
  await page.getByRole("button", { name: "1 step Search library" }).click();
  await expect(page.locator(".assistant-tool")).toBeVisible();
  // Docked: full height on the right edge, with the page shrinking beside it.
  const viewport = page.viewportSize()!;
  const docked = (await page.locator(".assistant-panel").boundingBox())!;
  const beside = (await page.locator(".workspace .content").boundingBox())!;
  expect(docked.width).toBe(420);
  expect(docked.x + docked.width).toBe(viewport.width);
  expect(docked.y + docked.height).toBe(viewport.height);
  expect(beside.x + beside.width).toBeLessThanOrEqual(docked.x);
  await page.getByRole("button", { name: "Expand chat" }).click();
  // Expanded: the whole content area beside the sidebar.
  const full = (await page.locator(".assistant-panel").boundingBox())!;
  expect(full.x + full.width).toBe(viewport.width);
  expect(full.width).toBeGreaterThan(docked.width * 1.5);
  await page.getByRole("button", { name: "Shrink chat" }).click();
  await page.screenshot({
    path: "../artifacts/agents/chat-activity-desktop.png",
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await page.locator(".assistant-panel").boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  await expect(composer).toBeVisible();
  await page.screenshot({
    path: "../artifacts/agents/chat-activity-mobile.png",
  });
  expect(
    (await new AxeBuilder({ page }).include(".assistant-panel").analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "New chat and choose model" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
    "capable",
  );
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("high");
});

test("reading earlier messages stays in place while streaming and jump returns to latest", async ({
  page,
}) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fake", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: {
        session_id: "fixture",
        token: "token",
        provider: "Fixture agent",
        model_name: "Fast model",
      },
    }),
  );
  let append: () => void = () => {};
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    let seq = 0;
    const emit = (type: string, extra: Record<string, unknown>) =>
      ws.send(
        JSON.stringify({
          type,
          seq: ++seq,
          session_id: "fixture",
          run_id: "r",
          ...extra,
        }),
      );
    append = () =>
      emit("text_delta", { text: "\n\nThe newest streamed paragraph." });
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).type !== "send") return;
      emit("run_started", { message: "Explain" });
      emit("text_delta", {
        text: Array.from(
          { length: 30 },
          (_, n) => `Paragraph ${n}: evidence and version history.`,
        ).join("\n\n"),
      });
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Fixture agent").fill("Explain");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".assistant-answer")).toContainText("Paragraph 29");
  const log = page.getByRole("log");
  // Markdown is lazy-loaded; wait for the actual scrollable paragraphs, not its text fallback.
  await expect(page.locator(".assistant-answer p")).toHaveCount(30);
  await expect
    .poll(() => log.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(
    page.getByRole("button", { name: "Jump to latest" }),
  ).toBeVisible();
  append();
  await expect(page.locator(".assistant-answer")).toContainText(
    "The newest streamed paragraph.",
  );
  expect(await log.evaluate((el) => el.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Jump to latest" }).click();
  expect(
    await log.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    ),
  ).toBeLessThan(2);
});

async function interactiveAgent(page: import("@playwright/test").Page) {
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [{ id: "fake", name: "Fixture agent", available: true }],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (route) =>
    route.fulfill({
      json: { session_id: "fixture", token: "test", provider: "Fixture agent" },
    }),
  );
  let seq = 0;
  let emit: (type: string, extra?: Record<string, unknown>) => void = () => {};
  const replies = new Map<
    string,
    { ok: boolean; result: Record<string, any> }
  >();
  let context: Record<string, any> = {};
  let sentContext: Record<string, any> = {};
  await page.routeWebSocket("**/api/agent-chat/fixture", (ws) => {
    emit = (type, extra = {}) =>
      ws.send(
        JSON.stringify({
          type,
          seq: ++seq,
          session_id: "fixture",
          run_id: "r",
          ...extra,
        }),
      );
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "context_update") context = message;
      if (message.type === "ui_result") replies.set(message.id, message);
      if (message.type === "cancel")
        emit("run_finished", { status: "cancelled" });
      if (message.type === "send") {
        sentContext = message.context;
        emit("run_started", { message: message.message });
        emit("ui_command", {
          id: "keyboard",
          name: "show_search",
          args: { query: 'grep -in "Each update is saved"', mode: "grep" },
          expires_at: Date.now() + 15000,
        });
      }
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByLabel("Message Fixture agent")).toBeVisible();
  await expect.poll(() => context.ready).toBe(true);
  const send = (
    name: string,
    args: Record<string, unknown>,
    expires = Date.now() + 15000,
  ) => {
    const id = `command${seq + 1}`;
    emit("ui_command", { id, name, args, expires_at: expires });
    return id;
  };
  const result = async (id: string) => {
    await expect.poll(() => replies.has(id)).toBe(true);
    return replies.get(id)!;
  };
  const command = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await result(send(name, args));
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result.completed).toBe(true);
    return reply.result;
  };
  return {
    send,
    result,
    command,
    emit,
    context: () => context,
    sentContext: () => sentContext,
  };
}

test("agents perform real search, navigation, selection, view and reader actions after Enter", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  const composer = page.getByLabel("Message Fixture agent");
  await composer.fill("Find the saved update");
  await composer.press("Enter");
  const searched = await agent.result("keyboard");
  expect(agent.sentContext()).toMatchObject({
    surface: "library",
    ready: true,
  });
  expect(searched.ok, JSON.stringify(searched)).toBe(true);
  expect(searched.result.state).toMatchObject({
    query: 'grep -in "Each update is saved"',
    mode: "grep",
    ready: true,
  });
  await expect(page.getByLabel("Search your knowledge")).toHaveValue(
    'grep -in "Each update is saved"',
  );
  await expect(
    page.getByRole("table", { name: "Search results" }),
  ).toContainText("storage-decisions.md");
  expect(searched.result.state.visible_documents.length).toBeGreaterThan(0);
  await agent.command("set_library_view", {
    view: "grid",
    sort: "filename",
    descending: true,
  });
  await expect(page.locator(".file-grid")).toBeVisible();
  const doc = searched.result.state.visible_documents.find(
    (d: { title: string }) => d.title === "storage-decisions.md",
  );
  const selected = await agent.command("select_files", {
    document_ids: [doc.document_id],
  });
  expect(selected.state.selection).toEqual([doc.document_id]);
  await expect(
    page.locator(
      `.file-row[data-document-id="${doc.document_id}"] .file-select`,
    ),
  ).toHaveAttribute("aria-pressed", "true");
  await agent.command("open_document", {
    document_id: doc.document_id,
    version: doc.version,
  });
  await expect(
    page.getByRole("tab", { name: "Document", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await agent.command("set_reader_view", { tab: "details", expanded: true });
  expect(agent.context()).toMatchObject({
    surface: "reader",
    visible_documents: [doc],
  });
  expect(agent.context().visible_documents).toHaveLength(1);
  await expect(
    page.getByRole("tab", { name: "Details", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(
    page.getByRole("button", { name: "Show file list", exact: true }),
  ).toBeVisible();
  const readerBox = await page
    .getByLabel("Document inspector", { exact: true })
    .boundingBox();
  const chatBox = await page.locator(".assistant-panel").boundingBox();
  expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(chatBox!.x);
  await page.screenshot({
    path: "../artifacts/agents/compact-reader-desktop.png",
  });
  await page.setViewportSize({ width: 1440, height: 500 });
  const scrolled = await agent.command("scroll_view", {
    target: "reader",
    direction: "bottom",
  });
  expect(scrolled.position).toBeGreaterThan(0);
  expect(
    await page.locator(".inspector-content").evaluate((el) => el.scrollTop),
  ).toBe(scrolled.position);
  await agent.command("scroll_view", { target: "reader", direction: "top" });
  expect(
    await page.locator(".inspector-content").evaluate((el) => el.scrollTop),
  ).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect.poll(() => agent.context().reader_tab).toBe("versions");
  await agent.command("set_reader_view", { tab: "document", expanded: false });
  await agent.command("scroll_view", { target: "reader", direction: "bottom" });
  await agent.command("close_document");
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toHaveCount(0);
  await agent.command("clear_search");
  await expect(page.getByLabel("Search your knowledge")).toHaveValue("");
  await page
    .locator(".assistant-opened")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect
    .poll(() => agent.context().query)
    .toBe('grep -in "Each update is saved"');
  await expect.poll(() => agent.context().ready).toBe(true);
  expect(agent.context()).toMatchObject({
    view: "grid",
    sort: "filename",
    descending: true,
  });
  await expect(page.locator(".file-grid")).toBeVisible();
  await agent.command("clear_search");
  await agent.command("set_library_view", { view: "map" });
  await expect(
    page.getByRole("region", { name: "Document connection map", exact: true }),
  ).toBeVisible();
  await agent.command("set_library_view", {
    view: "list",
    sort: "date",
    descending: true,
  });
  await expect(
    page.getByRole("columnheader", { name: "Modified" }),
  ).toHaveAttribute("aria-sort", "descending");
  const folder = agent.context().folders.find((f: string) => !!f);
  const navigated = await agent.command("navigate", {
    scope: "folder",
    folder,
  });
  expect(navigated.state).toMatchObject({
    scope: "folder",
    folder,
    query: "",
    ready: true,
  });
  await expect(
    page.getByRole("heading", {
      name: folder.split(" / ").at(-1),
      exact: true,
    }),
  ).toBeVisible();
  const bad = await agent.result(
    agent.send("navigate", { folder: "Does not exist" }),
  );
  expect(bad).toMatchObject({
    ok: false,
    result: { reason: "folder_not_found" },
  });
  await agent.command("navigate", { scope: "all" });
  // Each action has a real history entry, including its search, sorting and layout.
  await page
    .locator(".assistant-opened")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect.poll(() => agent.context().folder).toBe(folder);
  const group = agent.context().groups[0];
  const grouped = await agent.command("navigate", { scope: "group", group });
  expect(grouped.state).toMatchObject({ scope: "group", group, ready: true });
  await agent.command("navigate", { scope: "unfiled" });
  expect(agent.context().scope).toBe("unfiled");
  await agent.command("navigate", { scope: "recent" });
  expect(agent.context().scope).toBe("recent");
});

test("empty focused fields allow actions; blocked opens offer a manual recovery", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  const doc = agent
    .context()
    .visible_documents.find(
      (d: { title: string }) => d.title === "storage-decisions.md",
    );
  const pin = { document_id: doc.document_id, version: doc.version };
  await page.getByLabel("Search your knowledge").focus();
  await agent.command("open_document", pin);
  await agent.command("set_reader_view", { tab: "document", expanded: true });
  const find = page.getByLabel("Find in document", { exact: true });
  await find.focus();
  await agent.command("close_document");
  const composer = page.getByLabel("Message Fixture agent");
  await composer.fill("My unsent draft");
  const failed = await agent.result(agent.send("open_document", pin));
  expect(failed).toMatchObject({ ok: false, result: { reason: "user_busy" } });
  agent.emit("run_started", { message: "Open this document" });
  agent.emit("tool_call_started", {
    id: "blocked-open",
    name: "open_document",
    kind: "browser",
    args: pin,
  });
  agent.emit("tool_call_result", { id: "blocked-open", result: failed });
  agent.emit("run_finished", { status: "completed" });
  const card = page.locator(".assistant-tool");
  await expect(card).toContainText("Not completed");
  await expect(card).toContainText("Finish your unsent text");
  await card.getByRole("button", { name: "Open now" }).click();
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("My unsent draft");
});

test("read receipts show text coverage and answer checking does not claim the library is empty", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  const doc = agent
    .context()
    .visible_documents.find(
      (d: { title: string }) => d.title === "storage-decisions.md",
    );
  agent.emit("run_started", { message: "Read the document" });
  agent.emit("tool_call_started", {
    id: "read",
    name: "read_document",
    kind: "server",
  });
  agent.emit("tool_call_result", {
    id: "read",
    result: {
      document: { ...doc, filename: doc.title },
      status: "ok",
      characters_read: 12000,
      has_more: true,
    },
  });
  agent.emit("tool_call_started", { id: "ask", name: "ask", kind: "server" });
  agent.emit("tool_call_result", {
    id: "ask",
    result: {
      matches: [],
      answer: {
        status: "no_answer_in_evaluated_candidates",
        evaluated_count: 3,
      },
    },
  });
  agent.emit("run_finished", { status: "completed" });
  await expect(page.locator(".assistant-tool").first()).toContainText(
    "12000 characters read · More text available",
  );
  await expect(page.locator(".assistant-tool").last()).toContainText(
    "No verified answer in the checked passages.",
  );
  await expect(page.locator(".assistant-tool").last()).not.toContainText(
    "No matching documents.",
  );
  await page
    .locator(".assistant-tool")
    .first()
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toBeVisible();
  await agent.command("set_reader_view", { expanded: true });
  await page
    .getByRole("button", { name: "Close agent chat", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Reader file navigation" }),
  ).toContainText("Engineering");
  await expect(
    page.getByRole("navigation", { name: "Reader file navigation" }),
  ).toContainText("3 files");
});

test("Stop and user navigation prevent delayed UI actions, while search receipts wait for results", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  let release: () => void = () => {};
  let requested = false;
  await page.route("**/api/agent-document?*", async (route) => {
    requested = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue().catch(() => {});
  });
  const doc = agent.context().visible_documents[0];
  const id = agent.send("open_document", {
    document_id: doc.document_id,
    version: doc.version,
  });
  await expect.poll(() => requested).toBe(true);
  // Start a fixture run so the Stop control is available while the read is pending.
  const composer = page.getByLabel("Message Fixture agent");
  await composer.fill("Show results");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  release();
  expect(await agent.result(id)).toMatchObject({
    ok: false,
    result: { reason: "cancelled" },
  });
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toHaveCount(0);
  requested = false;
  const secondDoc = agent.context().visible_documents[1];
  const racing = agent.send("open_document", {
    document_id: secondDoc.document_id,
    version: secondDoc.version,
  });
  await expect.poll(() => requested).toBe(true);
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  release();
  expect(await agent.result(racing)).toMatchObject({
    ok: false,
    result: { reason: "view_changed" },
  });
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toHaveCount(0);
  requested = false;
  await expect.poll(() => agent.context().ready).toBe(true);
  const expiringDoc = agent
    .context()
    .visible_documents.find(
      (item: { document_id: string }) =>
        ![doc.document_id, secondDoc.document_id].includes(item.document_id),
    );
  const expiring = agent.send(
    "open_document",
    { document_id: expiringDoc.document_id, version: expiringDoc.version },
    Date.now() + 500,
  );
  await expect.poll(() => requested).toBe(true);
  expect(await agent.result(expiring)).toMatchObject({
    ok: false,
    result: { reason: "cancelled" },
  });
  release();
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/agent-document?*");

  requested = false;
  await page.route("**/api/search", async (route) => {
    requested = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  const searchId = agent.send("show_search", {
    query: 'grep -in "Each update is saved"',
    mode: "grep",
  });
  await expect.poll(() => requested).toBe(true);
  await expect.poll(() => agent.context().ready).toBe(false);
  expect(agent.context().visible_documents).toEqual([]);
  release();
  const result = await agent.result(searchId);
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    result: { completed: true, state: { ready: true } },
  });
});

test("mobile UI actions reveal the app and retain the active conversation", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const searched = await agent.command("show_search", {
    query: "Each update is saved",
    mode: "semantic",
  });
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await expect(page.getByLabel("Search your knowledge")).toHaveValue(
    "Each update is saved",
  );
  const doc = searched.state.visible_documents.find(
    (d: { title: string }) => d.title === "storage-decisions.md",
  );
  await agent.command("open_document", {
    document_id: doc.document_id,
    version: doc.version,
  });
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await expect(page.getByLabel("Message Fixture agent")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toHaveCount(0);
});

test("search errors are reported without blocking independent reader actions", async ({
  page,
}) => {
  const agent = await interactiveAgent(page);
  const doc = agent.context().visible_documents[0];
  const failed = await agent.result(
    agent.send("show_search", { query: "not a grep command", mode: "grep" }),
  );
  expect(failed).toMatchObject({
    ok: false,
    result: { reason: "view_load_failed" },
  });
  expect(failed.result.message).toContain("Use a grep command");
  await agent.command("open_document", {
    document_id: doc.document_id,
    version: doc.version,
  });
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toBeVisible();
  await agent.command("set_reader_view", { tab: "details" });
  await expect(
    page.getByRole("tab", { name: "Details", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await agent.command("close_document");
  await expect(
    page.getByLabel("Document inspector", { exact: true }),
  ).toHaveCount(0);
});
