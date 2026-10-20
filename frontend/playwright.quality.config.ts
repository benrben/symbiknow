import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "quality-gate.spec.ts",
  fullyParallel: true,
  workers: 3,
  timeout: 30000,
  reporter: "list",
  outputDir: "quality-test-results",
  use: {
    baseURL: "http://127.0.0.1:5176",
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          executablePath:
            process.env.SYMBIKNOW_CHROME ||
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run dev -- --port 5176",
    url: "http://127.0.0.1:5176",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
