import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const providers = [
  {
    id: "fixture",
    name: "Fixture agent",
    available: true,
    installed: true,
    version: "fixture",
    reason: "",
    untested: false,
  },
];
async function fixture(page: Page) {
  await page.route("**/api/agents", (r) =>
    r.fulfill({ json: { agents: providers } }),
  );
  await page.route("**/api/agent-models", (r) =>
    r.fulfill({
      json: {
        models: [
          {
            id: "fixture",
            name: "Fixture model",
            description: "An isolated model fixture.",
            default: true,
            efforts: ["low"],
            default_effort: "low",
          },
        ],
      },
    }),
  );
  await page.route("**/api/agent-sessions", (r) =>
    r.fulfill({
      json: {
        session_id: "audit",
        token: "fixture-token",
        provider: "Fixture agent",
        model: "fixture",
        model_name: "Fixture model",
      },
    }),
  );
  let sequence = 0;
  await page.routeWebSocket("**/api/agent-chat/audit", (ws) => {
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          type,
          session_id: "audit",
          seq: ++sequence,
          run_id: "run",
          ...extra,
        }),
      );
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "send") {
        emit("run_started", { message: message.message });
        emit("text_delta", {
          text:
            "A useful fixture answer.\n\n" +
            "LongUnbrokenReference".repeat(30) +
            "\n\n| Field | Value |\n|---|---|\n| Description | " +
            "long".repeat(100) +
            " |",
        });
        emit("run_finished", { status: "completed" });
      }
    });
  });
  await page.goto("/");
}

test("chat keyboard opening, Escape, and focus return", async ({ page }) => {
  await fixture(page);
  const launcher = page.getByRole("button", {
    name: "Ask an agent",
    exact: true,
  });
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".assistant-panel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Expand chat" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test("provider discovery failure can be retried without reopening chat", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route("**/api/agents", (r) =>
    ++attempts === 1
      ? r.fulfill({
          status: 503,
          json: { error: "Fixture discovery unavailable" },
        })
      : r.fulfill({ json: { agents: providers } }),
  );
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await expect(page.getByText("Checking installed agents…")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry agent discovery" }).click();
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(2);
});

for (const size of [
  { width: 320, height: 320 },
  { width: 390, height: 844 },
  { width: 768, height: 600 },
  { width: 1440, height: 900 },
]) {
  test(`chat setup and long answers remain usable at ${size.width}x${size.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await fixture(page);
    await page
      .getByRole("button", { name: "Ask an agent", exact: true })
      .click();
    await page.getByRole("button", { name: "Start chat", exact: true }).click();
    const message = page.getByLabel("Message Fixture agent");
    await message.fill("A long answer, please");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("A useful fixture answer.", { exact: true }),
    ).toBeVisible();
    await message.scrollIntoViewIfNeeded();
    await message.click();
    await expect(message).toBeFocused();
    const visible = await message.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        el.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        )
      );
    });
    expect(visible).toBe(true);
    expect(
      await page
        .locator(".assistant-panel")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("chat.png") });
    if (size.width === 390) {
      const results = await new AxeBuilder({ page })
        .include(".assistant-panel")
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
}

test("model discovery error exposes refresh and recovers", async ({ page }) => {
  await fixture(page);
  let attempts = 0;
  await page.route("**/api/agent-models", (r) =>
    ++attempts === 1
      ? r.fulfill({
          status: 503,
          json: { error: "Fixture model discovery unavailable" },
        })
      : r.fulfill({
          json: {
            models: [
              {
                id: "recovered",
                name: "Recovered model",
                description: "",
                default: true,
                efforts: [],
                default_effort: "",
              },
            ],
          },
        }),
  );
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture model discovery unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
    "recovered",
  );
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toBeEnabled();
});

test("lost approval delivery can be retried after reconnect without duplicate decisions", async ({
  page,
}) => {
  await fixture(page);
  let sequence = 0,
    connections = 0,
    decisions = 0;
  await page.routeWebSocket("**/api/agent-chat/audit", (ws) => {
    const connection = ++connections;
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          type,
          session_id: "audit",
          seq: ++sequence,
          run_id: "run",
          ...extra,
        }),
      );
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "send") {
        emit("run_started", { message: message.message });
        emit("tool_call_started", {
          id: "write",
          name: "remove_file",
          kind: "approval",
        });
        emit("tool_call_awaiting_approval", {
          id: "write",
          preview: {
            operation: "remove_file",
            warning: "Fixture change only",
            files: [{ filename: "fixture.txt", version: "v1" }],
          },
        });
        emit("run_finished", { status: "completed" });
      } else if (message.type === "approval") {
        if (connection === 1)
          ws.close({
            code: 1012,
            reason: "Fixture connection loss before delivery",
          });
        else {
          decisions++;
          emit("tool_call_denied", { id: "write" });
        }
      }
    });
  });
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Fixture agent").fill("Propose a change");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await deny.click();
  await expect.poll(() => connections).toBe(2);
  await expect(deny).toBeEnabled();
  await deny.click();
  await expect(
    page.getByText("You denied this. The agent was told."),
  ).toBeVisible();
  expect(decisions).toBe(1);
});

test("closing during startup disposes a late session without reopening chat", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false,
    closed = 0;
  await page.route("**/api/agent-sessions", async (route) => {
    requested = true;
    await pending;
    await route.fulfill({
      json: {
        session_id: "late",
        token: "fixture-token",
        provider: "Fixture agent",
        model: "fixture",
        model_name: "Fixture model",
      },
    });
  });
  await page.routeWebSocket("**/api/agent-chat/late", (ws) => {
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === "close") closed++;
    });
  });
  const launcher = page.getByRole("button", {
    name: "Ask an agent",
    exact: true,
  });
  await launcher.click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page
    .getByRole("button", { name: "Close agent chat", exact: true })
    .click();
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await expect(launcher).toBeFocused();
  release();
  await expect.poll(() => closed).toBe(1);
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await launcher.click();
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toBeEnabled();
});

test("approval actions disable immediately until a receipt arrives", async ({
  page,
}) => {
  await fixture(page);
  let sequence = 0,
    decisions = 0;
  let receipt!: () => void;
  await page.routeWebSocket("**/api/agent-chat/audit", (ws) => {
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      ws.send(
        JSON.stringify({
          type,
          session_id: "audit",
          seq: ++sequence,
          run_id: "run",
          ...extra,
        }),
      );
    receipt = () => emit("tool_call_denied", { id: "write" });
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "send") {
        emit("run_started", { message: message.message });
        emit("tool_call_started", {
          id: "write",
          name: "remove_file",
          kind: "approval",
        });
        emit("tool_call_awaiting_approval", {
          id: "write",
          preview: {
            operation: "remove_file",
            warning: "Fixture change only",
            files: [{ filename: "fixture.txt", version: "v1" }],
          },
        });
        emit("run_finished", { status: "completed" });
      } else if (message.type === "approval") decisions++;
    });
  });
  await page.getByRole("button", { name: "Ask an agent", exact: true }).click();
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.getByLabel("Message Fixture agent").fill("Propose a change");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Deny", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeDisabled();
  expect(decisions).toBe(1);
  receipt();
  await expect(
    page.getByText("You denied this. The agent was told."),
  ).toBeVisible();
});

test("delayed chat chunk preserves the launcher and file double-click target at 768px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 844 });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/src/features/assistant/Assistant.tsx*",
    async (route) => {
      await pending;
      await route.continue();
    },
  );
  await fixture(page);
  const launcher = page.getByRole("button", {
    name: "Ask an agent",
    exact: true,
  });
  const file = page.getByRole("button", {
    name: "Select storage-decisions.md",
    exact: true,
  });
  try {
    await expect(launcher).toBeVisible();
    await file.scrollIntoViewIfNeeded();
    const before = await file.boundingBox();
    await launcher.click();
    await expect(
      page.getByText("Loading chat…", { exact: true }),
    ).toBeVisible();
    release();
    await expect(page.locator(".assistant-panel")).toBeVisible();
    await page
      .getByRole("button", { name: "Close agent chat", exact: true })
      .click();
    const after = await file.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.x).toBeCloseTo(before!.x, 0);
    await file.dblclick();
    await expect(
      page.getByRole("searchbox", { name: "Find in document" }),
    ).toBeVisible();
  } finally {
    release();
  }
});
