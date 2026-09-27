import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.quality', { recursive: true });
const report = resolve('.quality/vitest-results.json');
rmSync(report, { force: true });
const result = spawnSync(
  resolve('node_modules/.bin/vitest'),
  ['run', '--reporter=json', `--outputFile=${report}`, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  try {
    const summary = JSON.parse(readFileSync(report, 'utf8'));
    for (const suite of summary.testResults ?? []) {
      for (const test of suite.assertionResults ?? []) {
        if (test.status !== 'failed') continue;
        console.error(`FAIL ${test.fullName} (${suite.name})`);
        for (const message of test.failureMessages ?? []) console.error(message);
      }
    }
  } catch { /* Vitest may have exited before producing a report. */ }
  process.exit(result.status ?? 1);
}

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
