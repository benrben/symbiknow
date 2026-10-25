import { defineConfig } from "@playwright/test";
const port = process.env.SYMBIKNOW_UI_PORT || "8766";
const devPort = process.env.SYMBIKNOW_DEV_PORT || "5174";
const baseURL = `http://127.0.0.1:${devPort}`;
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: [
    "**/quality-gate.spec.ts",
    "**/mobile-accessibility.spec.ts",
    "**/performance.spec.ts",
  ],
  outputDir: process.env.SYMBIKNOW_UI_RESULTS || "test-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    launchOptions: process.env.SYMBIKNOW_CHROME
      ? { executablePath: process.env.SYMBIKNOW_CHROME }
      : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "../.venv/bin/python ../backend/tests/support/ui_fixture.py",
      url: `http://127.0.0.1:${port}/api/library`,
      reuseExistingServer: false,
      timeout: 60000,
      env: { SYMBIKNOW_UI_PORT: port, SYMBIKNOW_WARMUP: "0" },
    },
    {
      command: `npm run dev -- --config tests/vite.config.ts --port ${devPort}`,
      url: `http://127.0.0.1:${devPort}`,
      reuseExistingServer: false,
      timeout: 60000,
      env: { SYMBIKNOW_UI_PORT: port },
    },
  ],
});
