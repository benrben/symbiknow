import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = process.env.SYMBIKNOW_UI_PORT || "8881";
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  ...base,
  testMatch: "**/performance.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL },
  webServer: {
    command: "../.venv/bin/python ../backend/tests/support/ui_fixture.py",
    url: `${baseURL}/api/library`,
    reuseExistingServer: false,
    timeout: 60000,
    env: { SYMBIKNOW_UI_PORT: port, SYMBIKNOW_METADATA_ROWS: "240", SYMBIKNOW_WARMUP: "0" },
  },
});
