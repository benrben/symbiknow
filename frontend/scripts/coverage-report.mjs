// Converts Chromium coverage recorded by tests/coverage.ts into LCOV for frontend/src.
// Usage: node scripts/coverage-report.mjs RAW_DIR BUILD_DIR OUTPUT_LCOV
import fs from "node:fs/promises";
import path from "node:path";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import v8ToIstanbul from "v8-to-istanbul";

const [rawDir, buildDir, output] = process.argv.slice(2);
if (!rawDir || !buildDir || !output) {
  console.error("usage: coverage-report.mjs RAW_DIR BUILD_DIR OUTPUT_LCOV");
  process.exit(2);
}
const sourceRoot = path.resolve("src") + path.sep;

async function buildFileFor(url) {
  const { pathname } = new URL(url);
  if (!pathname.endsWith(".js")) return null;
  const file = path.join(path.resolve(buildDir), pathname);
  try {
    await fs.access(`${file}.map`);
    return file;
  } catch {
    return null;
  }
}

async function addEntry(map, entry) {
  const file = await buildFileFor(entry.url);
  if (!file) return;
  const sourcemap = JSON.parse(await fs.readFile(`${file}.map`, "utf8"));
  const converter = v8ToIstanbul(file, 0, {
    source: entry.source,
    sourceMap: { sourcemap },
  });
  await converter.load();
  converter.applyCoverage(entry.functions);
  for (const [name, data] of Object.entries(converter.toIstanbul())) {
    if (path.resolve(name).startsWith(sourceRoot)) map.merge({ [name]: data });
  }
}

const map = libCoverage.createCoverageMap({});
const rawFiles = (await fs.readdir(rawDir)).filter((n) => n.endsWith(".json"));
if (rawFiles.length === 0) {
  console.error(`no coverage recordings in ${rawDir}`);
  process.exit(1);
}
for (const name of rawFiles) {
  const entries = JSON.parse(
    await fs.readFile(path.join(rawDir, name), "utf8"),
  );
  for (const entry of entries) await addEntry(map, entry);
}
if (map.files().length === 0) {
  console.error("coverage recordings matched no frontend/src files");
  process.exit(1);
}
const outputDir = path.dirname(path.resolve(output));
await fs.mkdir(outputDir, { recursive: true });
const context = libReport.createContext({ dir: outputDir, coverageMap: map });
reports.create("lcovonly", { file: path.basename(output) }).execute(context);
console.log(`Wrote ${map.files().length} frontend files to ${output}`);
