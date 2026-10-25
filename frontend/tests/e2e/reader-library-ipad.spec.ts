import { test, expect, devices } from "@playwright/test";
import { fixture, audit } from "../support/quality-fixture";
test.use({ ...devices["iPad (gen 7)"], browserName: "webkit" });
test("file action names keep readiness descriptions without a visible-label mismatch", async ({
  page,
}) => {
  await fixture(page);
  const file = page.getByRole("button", {
    name: "Select Guide.md",
    exact: true,
  });
  await expect(file).toHaveAccessibleDescription(
    /Original saved.*Search ready/,
  );
  await audit(page, "iPad library file labels");
});
test("double click opens the reader and gives close focus", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Select Guide.md", exact: true })
    .dblclick();
  await expect(
    page.getByRole("button", { name: /^(Back to library|Close inspector)$/ }),
  ).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("ipad-reader.png") });
});
