import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.quality', { recursive: true });
const report = resolve('.quality/vitest-results.json');
const result = spawnSync(
  resolve('node_modules/.bin/vitest'),
  ['run', '--reporter=json', `--outputFile=${report}`, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const summary = JSON.parse(readFileSync(report, 'utf8'));
const total = summary.numTotalTests;
const passed = summary.numPassedTests;
const failed = summary.numFailedTests;
const skipped = summary.numPendingTests;
if (![total, passed, failed, skipped].every(Number.isInteger)) {
  throw new Error('Vitest did not provide complete test totals.');
}
console.log(`# tests ${total}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
console.log(`# skipped ${skipped}`);
