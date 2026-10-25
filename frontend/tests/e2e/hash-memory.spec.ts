import { test, expect, chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
test("paired 64MiB hash native browser memory", async () => {
  test.setTimeout(90000);
  const dir = await fs.mkdtemp(
    path.join((await import("node:os")).tmpdir(), "symbiknow-hash-"),
  );
  const file = path.join(dir, "hash.bin");
  const handle = await fs.open(file, "w");
  for (let i = 0; i < 64; i++) await handle.write(Buffer.alloc(1024 ** 2, 87));
  await handle.close();
  const reports: unknown[] = [];
  for (const mode of ["old", "worker"]) {
    const browser = await chromium.launch({
      executablePath: process.env.SYMBIKNOW_CHROME,
    });
    try {
      const page = await browser.newPage();
      await page.goto(
        `http://127.0.0.1:${process.env.SYMBIKNOW_DEV_PORT || "5174"}/`,
      );
      await page.evaluate(async () => {
        await import(/* @vite-ignore */ "/src/shared/api/client.ts");
      });
      await page.evaluate(() => {
        const i = document.createElement("input");
        i.id = "hash-file";
        i.type = "file";
        document.body.append(i);
      });
      await page.locator("#hash-file").setInputFiles(file);
      const system = await browser.newBrowserCDPSession();
      const pageCDP = await page.context().newCDPSession(page);
      const samples: unknown[] = [];
      async function sample(stage: string) {
        const { processInfo } = await system.send("SystemInfo.getProcessInfo");
        const native = JSON.parse(
          execFileSync(
            path.join(root, ".venv/bin/python"),
            [
              path.join(root, "benchmarks/helpers/process_snapshot.py"),
              ...processInfo.map((p) => String(p.id)),
            ],
            { encoding: "utf8" },
          ),
        );
        samples.push({
          stage,
          native,
          heap: await pageCDP.send("Runtime.getHeapUsage"),
        });
      }
      await sample("before");
      const timer = setInterval(() => {
        void sample("hashing");
      }, 100);
      const start = Date.now();
      const digest = await page.evaluate(async (mode) => {
        const f =
          document.querySelector<HTMLInputElement>("#hash-file")!.files![0];
        if (mode === "old") {
          const data = await f.arrayBuffer();
          (window as any).heldUploadBuffer = data;
          return Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
            (x) => x.toString(16).padStart(2, "0"),
          ).join("");
        }
        const { hashFile } = await import(
          /* @vite-ignore */ "/src/shared/api/client.ts"
        );
        return hashFile(f);
      }, mode);
      clearInterval(timer);
      const ms = Date.now() - start;
      await sample("after");
      expect(digest).toHaveLength(64);
      reports.push({ mode, ms, digest, samples });
    } finally {
      await browser.close();
    }
  }
  expect((reports[0] as any).digest).toBe((reports[1] as any).digest);
  await fs.mkdir(path.join(root, "artifacts/memory-research"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "artifacts/memory-research/browser-hash-paired.json"),
    JSON.stringify(
      {
        bytes: 64 * 1024 ** 2,
        reports,
        limitations:
          "Matched hash workload in fresh Chrome processes. Old buffer remains live as during its subsequent chunk upload. This is hashing, not end-to-end upload. Native samples include worker memory; GPU and process footprint must not be added.",
      },
      null,
      2,
    ),
  );
  await fs.rm(dir, { recursive: true, force: true });
});
