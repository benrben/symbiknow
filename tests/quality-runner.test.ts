import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
const runner = path.resolve('.quality/run-tests.mjs');
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function runFixture(body: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-test-runner-'));
  directories.push(directory);
  const executable = path.join(directory, 'node_modules', '.bin', 'vitest');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
  await chmod(executable, 0o755);
  return spawnSync(process.execPath, [runner], { cwd: directory, encoding: 'utf8' });
}

it('reports complete totals from successful Vitest results', async () => {
  const result = await runFixture(`const fs = require('node:fs');
    fs.writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13),
      JSON.stringify({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0 }));`);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('# tests 3\n# pass 3\n# fail 0\n# skipped 0');
});

it('keeps individual failures visible and preserves the failed runner status', async () => {
  const result = await runFixture(`const fs = require('node:fs');
    fs.writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13),
      JSON.stringify({ testResults: [{ name: 'fixture.test.ts', assertionResults: [
        { status: 'passed', fullName: 'Successful fixture' },
        { status: 'failed', fullName: 'Failure fixture', failureMessages: ['Expected persisted result'] },
      ] }] })); process.exit(2);`);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('FAIL Failure fixture (fixture.test.ts)');
  expect(result.stderr).toContain('Expected persisted result');
});

it('reports a missing diagnostic report instead of silently swallowing the failure', async () => {
  const result = await runFixture('process.exit(2);');
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Vitest exited before producing a test report.');
});

it('surfaces malformed reports as invalid diagnostics', async () => {
  const result = await runFixture(`const fs = require('node:fs');
    fs.writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13), '{'); process.exit(2);`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('SyntaxError');
});
