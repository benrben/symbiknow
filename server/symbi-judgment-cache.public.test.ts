import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SymbiJudgmentCache } from './symbi-judgment-cache.js';

it('coalesces a paid judgment and reuses its durable result after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-'));
  try {
    const cache = await SymbiJudgmentCache.open(root);
    const call = vi.fn(async () => ({ verdict: 'yes', sourceHash: 'current' }));
    const [first, second] = await Promise.all([
      cache.getOrRun('same-scope-and-source', call), cache.getOrRun('same-scope-and-source', call),
    ]);
    expect(first).toMatchObject({ state: 'complete', value: { verdict: 'yes' } });
    expect(second).toMatchObject({ state: 'complete', value: { verdict: 'yes' } });
    expect(call).toHaveBeenCalledTimes(1);
    const reopened = await SymbiJudgmentCache.open(root);
    expect(await reopened.getOrRun('same-scope-and-source', call)).toMatchObject({
      state: 'complete', reused: true, value: { sourceHash: 'current' },
    });
    expect(call).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not repeat a provider call with an interrupted durable request marker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-'));
  try {
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify([
      { key: 'interrupted', state: 'running', updatedAt: new Date().toISOString() },
    ]));
    const cache = await SymbiJudgmentCache.open(root);
    const call = vi.fn(async () => ({ verdict: 'yes' }));
    expect(await cache.getOrRun('interrupted', call)).toMatchObject({ state: 'interrupted' });
    expect(call).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('loads only valid durable entries and distinguishes failed from interrupted judgments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-valid-'));
  try {
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify([
      null, 'invalid primitive', {}, { key: 3, state: 'complete' }, { key: 'missing-state' },
      { key: 'bad-state', state: 'unknown' },
      { key: 'complete-in-scope', state: 'complete', value: { verdict: 'yes' }, updatedAt: 'now' },
      { key: 'failed', state: 'failed', error: 'provider unavailable', updatedAt: 'now' },
      { key: 'failed-no-error', state: 'failed', updatedAt: 'now' },
      { key: 'running-no-error', state: 'running', updatedAt: 'now' },
    ]));
    const cache = await SymbiJudgmentCache.open(root);
    const run = vi.fn(async () => ({ verdict: 'different source' }));
    expect(await cache.getOrRun('complete-in-scope', run)).toEqual({ state: 'complete', value: { verdict: 'yes' }, reused: true });
    expect(await cache.getOrRun('failed', run)).toEqual({ state: 'failed', reason: 'provider unavailable' });
    expect(await cache.getOrRun('failed-no-error', run)).toMatchObject({ state: 'failed', reason: expect.stringContaining('previous provider request') });
    expect(await cache.getOrRun('running-no-error', run)).toMatchObject({ state: 'interrupted', reason: expect.stringContaining('previous provider request') });
    expect(await cache.getOrRun('same-question-new-source-hash', run)).toMatchObject({ state: 'complete', value: { verdict: 'different source' } });
    expect(run).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects malformed persisted cache data instead of allowing a repeated provider call', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-corrupt-'));
  try {
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify({ not: 'an entry list' }));
    await expect(SymbiJudgmentCache.open(root)).rejects.toThrow('Invalid judgment cache');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('fails closed when persisted running markers exceed the bounded cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-over-capacity-'));
  try {
    const entries = Array.from({ length: 257 }, (_, index) => ({ key: `running-${index}`, state: 'running', updatedAt: 'now' }));
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify(entries));
    await expect(SymbiJudgmentCache.open(root)).rejects.toThrow('exceeds its durable capacity');
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify(entries.slice(0, 256)));
    const cache = await SymbiJudgmentCache.open(root);
    const provider = vi.fn(async () => 'must not run');
    expect(await cache.getOrRun('new-question', provider)).toMatchObject({ state: 'failed',
      reason: expect.stringContaining('full of active requests') });
    expect(provider).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('never truncates active request markers even if an internal capacity invariant is violated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-invariant-'));
  try {
    const cache = await SymbiJudgmentCache.open(root);
    const internal = cache as unknown as { entries: Map<string, { key: string; state: 'running'; updatedAt: string }>;
      save(): Promise<void> };
    for (let index = 0; index < 257; index++) internal.entries.set(`active-${index}`,
      { key: `active-${index}`, state: 'running', updatedAt: 'now' });
    await expect(internal.save()).rejects.toThrow('cannot evict an active request');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps at most 256 durable completed entries and evicts the oldest completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-bounded-'));
  try {
    const entries = Array.from({ length: 256 }, (_, index) => ({ key: `old-${index}`, state: 'complete',
      updatedAt: '2026-01-01', value: index }));
    await writeFile(path.join(root, 'symbi-judgments.json'), JSON.stringify(entries));
    const cache = await SymbiJudgmentCache.open(root);
    expect(await cache.getOrRun('new-source-and-scope', async () => 999)).toEqual({ state: 'complete', value: 999, reused: false });
    const disk = JSON.parse(await readFile(path.join(root, 'symbi-judgments.json'), 'utf8')) as Array<{ key: string }>;
    expect(disk).toHaveLength(256);
    expect(disk.some(entry => entry.key === 'old-0')).toBe(false);
    expect(disk.some(entry => entry.key === 'new-source-and-scope')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('records provider exceptions without repeat calls and truncates durable error text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-failure-'));
  try {
    const cache = await SymbiJudgmentCache.open(root);
    const longError = 'provider failed: '.repeat(30);
    const failure = vi.fn(async () => { throw new Error(longError); });
    expect(await cache.getOrRun('long-error', failure)).toEqual({ state: 'failed', reason: longError });
    expect(await cache.getOrRun('long-error', failure)).toEqual({ state: 'failed', reason: longError.slice(0, 200) });
    const unknown = vi.fn(async () => { throw 'non-Error failure'; });
    expect(await cache.getOrRun('unknown-error', unknown)).toEqual({ state: 'failed', reason: 'Provider request failed' });
    expect(await SymbiJudgmentCache.open(root).then(reopened => reopened.getOrRun('unknown-error', unknown)))
      .toEqual({ state: 'failed', reason: 'Provider request failed' });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(unknown).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not call a provider until the running marker is durable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-judgments-reservation-'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const cache = await SymbiJudgmentCache.open(root);
    const file = path.join(root, 'symbi-judgments.json');
    await mkdir(file);
    const provider = vi.fn(async () => ({ verdict: 'yes' }));
    await expect(cache.getOrRun('reservation-failed', provider)).resolves.toMatchObject({ state: 'failed' });
    expect(provider).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Judgment cache persistence failed:', expect.objectContaining({ code: 'EISDIR' }));
    await rm(file, { recursive: true });
    expect(await cache.getOrRun('reservation-failed', provider)).toEqual({ state: 'complete', value: { verdict: 'yes' }, reused: false });
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
