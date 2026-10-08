import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

type NativeResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
const timings: Array<NativeResult & { name: string; programWriteMs: number; subprocessMs: number }> = [];
const runner = path.resolve('.quality/run-tests.mjs');
let directory: string;
let fixtureSetupMs: number;

beforeAll(async () => {
  const started = performance.now();
  directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-test-runner-'));
  const executable = path.join(directory, 'node_modules', '.bin', 'vitest');
  await mkdir(path.dirname(executable), { recursive: true });
  // Resolve the interpreter once; the runner still launches this real executable for every case.
  await writeFile(executable, `#!${process.execPath}\nconst prefix = '--fixture-program=';\nrequire(process.argv.find(arg => arg.startsWith(prefix)).slice(prefix.length));\n`);
  await chmod(executable, 0o755);
  fixtureSetupMs = performance.now() - started;
});

afterAll(async () => {
  try { await writeFile('/tmp/quality-runner-fixture-timings.json', JSON.stringify({ fixtureSetupMs, interpreter: process.execPath, cases: timings }, null, 2)); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

function runNative(program: string): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, `--fixture-program=${program}`], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function runFixture(body: string) {
  const started = performance.now();
  const program = path.join(directory, `case-${timings.length}.cjs`);
  await writeFile(program, body + '\n');
  const ready = performance.now();
  const result = await runNative(program);
  timings.push({ name: expect.getState().currentTestName!, programWriteMs: ready - started, subprocessMs: performance.now() - ready, ...result });
  return result;
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
  await expect(readFile(path.join(directory, '.quality', 'vitest-results.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('surfaces malformed reports as invalid diagnostics', async () => {
  const result = await runFixture(`const fs = require('node:fs');
    fs.writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13), '{'); process.exit(2);`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('SyntaxError');
});
