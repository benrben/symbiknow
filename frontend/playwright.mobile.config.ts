import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "mobile-accessibility.spec.ts",
  fullyParallel: true,
  workers: 3,
  timeout: 90000,
  outputDir: "mobile-test-results",
  use: {
    baseURL: "http://127.0.0.1:5180",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "iphone-se",
      use: { ...devices["iPhone SE"], browserName: "webkit" },
    },
    {
      name: "iphone-13",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
    {
      name: "ipad",
      use: { ...devices["iPad (gen 7)"], browserName: "webkit" },
    },
    {
      name: "android",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        launchOptions: {
          executablePath: process.env.SYMBIKNOW_CHROME,
        },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5180",
    url: "http://127.0.0.1:5180",
    reuseExistingServer: false,
  },
});
