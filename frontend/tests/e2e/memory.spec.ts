import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const output = path.join(project, "artifacts/memory-research");
test("bounded upload, unchanged polls, lazy history and native ZIP download", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) requests.push(r.url());
  });
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await expect(page.locator(".file-row")).toHaveCount(7);
  const session = await page.context().newCDPSession(page);
  const report: Record<string, unknown> = {
    bytes: 64 * 1024 ** 2,
    stages: [],
    limitation:
      "Chrome native buffers and worker memory are included in the process-tree report, not page JS heap alone.",
  };
  const snapshots: unknown[] = [];
  const browserSession = await browser.newBrowserCDPSession();
  async function sample(stage: string) {
    const { processInfo } = await browserSession.send(
      "SystemInfo.getProcessInfo",
    );
    const native = JSON.parse(
      execFileSync(
        path.join(project, ".venv/bin/python"),
        [
          path.join(project, "benchmarks/helpers/process_snapshot.py"),
          ...processInfo.map((p) => String(p.id)),
        ],
        { encoding: "utf8" },
      ),
    );
    snapshots.push({
      native,
      stage,
      seconds: Date.now() / 1000,
      heap: await session.send("Runtime.getHeapUsage"),
    });
  }
  await sample("initial");
  const initialPolls = requests.filter((x) =>
    x.includes("/api/library?"),
  ).length;
  await page.waitForTimeout(8500);
  const idlePolls =
    requests.filter((x) => x.includes("/api/library?")).length - initialPolls;
  expect(idlePolls).toBe(0);
  report.unchanged_library_reads_in_8s = idlePolls;
  const dir = await fs.mkdtemp("/private/tmp/symbiknow-browser-transfer-");
  const filename = path.join(dir, "memory-transfer.bin");
  const file = await fs.open(filename, "w");
  const block = Buffer.alloc(1024 ** 2, 87);
  for (let i = 0; i < 64; i++) await file.write(block);
  await file.close();
  // Reproduce the previous full-buffer hash in the same renderer, then release it.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "baseline-file";
    document.body.append(input);
  });
  await page.locator("#baseline-file").setInputFiles(filename);
  const baselineStart = Date.now();
  await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>("#baseline-file")!;
    const data = await input.files![0].arrayBuffer();
    (window as unknown as Record<string, unknown>).__baselineBuffer = data;
    await crypto.subtle.digest("SHA-256", data);
  });
  report.old_full_buffer_hash_ms = Date.now() - baselineStart;
  await sample("old_full_buffer_held");
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__baselineBuffer;
    document.querySelector("#baseline-file")?.remove();
  });
  await session.send("HeapProfiler.collectGarbage");
  await sample("old_buffer_released");
  // Any application call to File.arrayBuffer() would violate the bounded-read contract.
  await page.evaluate(() => {
    File.prototype.arrayBuffer = async () => {
      throw new Error("Whole-file buffering is forbidden");
    };
  });
  const timer = setInterval(() => {
    void sample("upload").catch(() => {});
  }, 150);
  let started = Date.now();
  try {
    await page.locator('input[type="file"]').first().setInputFiles(filename);
    await expect(
      page.getByText("memory-transfer.bin", { exact: true }).first(),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await (await page.request.get("/api/library?limit=100")).json()
          ).documents.some(
            (d: { filename: string }) => d.filename === "memory-transfer.bin",
          ),
        { timeout: 90000 },
      )
      .toBe(true);
    report.upload_ms = Date.now() - started;
  } finally {
    clearInterval(timer);
  }
  await sample("after_upload");
  const library = await (
    await page.request.get("/api/library?limit=100")
  ).json();
  const doc = library.documents.find(
    (d: { filename: string }) => d.filename === "memory-transfer.bin",
  );
  expect(doc.size).toBe(64 * 1024 ** 2);
  const summary = await (
    await page.request.get(
      `/api/document?id=${doc.document_id}&section=summary`,
    )
  ).json();
  expect(summary.versions).toHaveLength(1);
  expect(summary.evidence).toEqual([]);
  started = Date.now();
  const response = await page.request.post("/api/bulk-download", {
    headers: { "X-Symbiknow-UI": "1", Origin: origin },
    data: { prepare: true, documents: [doc] },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json();
  const downloadPromise = page.waitForEvent("download");
  await page.evaluate((url) => {
    const a = document.createElement("a");
    a.href = url;
    a.click();
  }, url);
  const download = await downloadPromise;
  const saved = (await download.path())!;
  expect((await fs.stat(saved)).size).toBeGreaterThan(doc.size);
  const digest = execFileSync(
    path.join(project, ".venv/bin/python"),
    [
      "-c",
      "import hashlib,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); f=z.open(z.namelist()[0]); print(hashlib.file_digest(f,'sha256').hexdigest())",
      saved,
    ],
    { encoding: "utf8" },
  ).trim();
  expect(digest).toBe(doc.sha256);
  report.zip_ms = Date.now() - started;
  await sample("after_native_zip");
  report.stages = snapshots;
  report.browser_processes = await browserSession.send(
    "SystemInfo.getProcessInfo",
  );
  const reportPath = process.env.SYMBIKNOW_MEMORY_REPORT || path.join(output, "browser-memory.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2),
  );
  await page.request.post("/api/delete-document", {
    headers: { "X-Symbiknow-UI": "1", Origin: origin },
    data: { document_id: doc.document_id, expected_version: doc.version },
  });
  await fs.rm(dir, { recursive: true, force: true });
});
