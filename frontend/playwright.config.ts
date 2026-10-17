import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8766",
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
      command: "../.venv/bin/python ../tests/ui_fixture.py",
      url: "http://127.0.0.1:8766/api/library",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: "npm run dev -- --config tests/vite.config.ts --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
