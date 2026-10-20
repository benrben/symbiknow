import { test as base, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

// Records Chromium JS coverage when UI_COVERAGE_DIR is set (quality gate runs only).
const coverageDir = process.env.UI_COVERAGE_DIR;

export const test = base.extend<{ recordCoverage: void }>({
  recordCoverage: [
    async ({ page }, use, testInfo) => {
      if (!coverageDir) {
        await use();
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      const entries = await page.coverage.stopJSCoverage();
      await fs.mkdir(coverageDir, { recursive: true });
      const name = `${testInfo.testId}-${testInfo.retry}.json`;
      await fs.writeFile(path.join(coverageDir, name), JSON.stringify(entries));
    },
    { auto: true },
  ],
});

export { expect };
