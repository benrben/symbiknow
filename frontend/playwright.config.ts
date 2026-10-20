import { defineConfig } from "@playwright/test";
const port = process.env.SYMBIKNOW_UI_PORT || "8766";
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // The accessibility/reflow suite runs in all three engines via test:quality.
  testIgnore: ["**/quality-gate.spec.ts", "**/mobile-accessibility.spec.ts"],
  outputDir: process.env.SYMBIKNOW_UI_RESULTS || "test-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    launchOptions: {
      executablePath:
        process.env.SYMBIKNOW_CHROME ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "../.venv/bin/python ../backend/tests/support/ui_fixture.py",
      url: `${baseURL}/api/library`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    ...(port === "8766"
      ? [
          {
            command: "npm run dev -- --config tests/vite.config.ts --port 5174",
            url: "http://127.0.0.1:5174",
            reuseExistingServer: !process.env.CI,
            timeout: 60000,
          },
        ]
      : []),
  ],
});
