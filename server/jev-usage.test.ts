import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jevUsageSummary, registerJevUsageLogging } from './jev-usage.js';
import { decideWithJev, JEV_MODEL, noul } from './jev.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-jev-usage-'));
  dirs.push(dir);
  return dir;
}

function successFetcher(inputTokens: number, outputTokens: number): typeof fetch {
  return (async () => Response.json({ answers: { q: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens } })) as unknown as typeof fetch;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('Jev usage logging', () => {
  it('records usage from successful Jev calls and totals month and today with estimated cost', async () => {
    const root = await tempDir();
    const stop = registerJevUsageLogging(root);
    try {
      await decideWithJev('key', { doc: 'x' }, { q: noul('Is this relevant?') }, successFetcher(1_000, 20));
      await decideWithJev('key', { doc: 'y' }, { q: noul('Another?') }, successFetcher(1_000, 20));
      const summary = await vi.waitFor(async () => {
        const result = await jevUsageSummary(root);
        if (result.month.requests < 2) throw new Error('usage not written yet');
        return result;
      }, { timeout: 2000, interval: 10 });
      expect(summary.model).toBe(JEV_MODEL);
      expect(summary.month).toMatchObject({ requests: 2, questions: 2, inputTokens: 2_000, outputTokens: 40 });
      expect(summary.month.estimatedCostUsd).toBeCloseTo((2_000 * 42) / 1_000_000_000, 12);
      expect(summary.today).toMatchObject({ requests: 2, questions: 2, inputTokens: 2_000, outputTokens: 40 });
    } finally { stop(); }
  });

  it('never writes API keys or Jev state to the usage log', async () => {
    const root = await tempDir();
    const stop = registerJevUsageLogging(root);
    try {
      await decideWithJev('super-secret-key', { doc: 'sensitive content' }, { q: noul('Is this relevant?') }, successFetcher(500, 5));
      await vi.waitFor(async () => {
        const result = await jevUsageSummary(root);
        if (result.month.requests < 1) throw new Error('usage not written yet');
      }, { timeout: 2000, interval: 10 });
      const { readFile } = await import('node:fs/promises');
      const month = new Date().toISOString().slice(0, 7);
      const raw = await readFile(path.join(root, 'jev-usage', `${month}.jsonl`), 'utf8');
      expect(raw).not.toContain('super-secret-key');
      expect(raw).not.toContain('sensitive content');
    } finally { stop(); }
  });

  it('does not throw and only logs when a usage write fails', async () => {
    const parent = await tempDir();
    const fileAsRoot = path.join(parent, 'not-a-directory');
    await writeFile(fileAsRoot, 'x');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = registerJevUsageLogging(fileAsRoot);
    try {
      const answers = await decideWithJev('key', { doc: 'x' }, { q: noul('Is this relevant?') }, successFetcher(10, 1));
      expect(answers.q).toMatchObject({ type: 'noul' });
      await vi.waitFor(() => { if (!errorSpy.mock.calls.length) throw new Error('not logged yet'); }, { timeout: 2000, interval: 10 });
      expect(errorSpy).toHaveBeenCalledWith('Could not record Jev usage', expect.anything());
    } finally { stop(); }
  });

  it('returns zeroed totals when no usage file exists for the current month', async () => {
    const root = await tempDir();
    const summary = await jevUsageSummary(root);
    expect(summary).toEqual({ model: JEV_MODEL, month: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      today: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
  });

  it('saves usage files with restricted permissions', async () => {
    const root = await tempDir();
    const stop = registerJevUsageLogging(root);
    try {
      await decideWithJev('key', { doc: 'x' }, { q: noul('Is this relevant?') }, successFetcher(10, 1));
      await vi.waitFor(async () => {
        const month = new Date().toISOString().slice(0, 7);
        const info = await stat(path.join(root, 'jev-usage', `${month}.jsonl`));
        if ((info.mode & 0o777) !== 0o600) throw new Error('unexpected mode');
      }, { timeout: 2000, interval: 10 });
    } finally { stop(); }
  });
});
