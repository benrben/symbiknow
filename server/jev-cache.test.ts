import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JevCache, jevCacheKey, stableStringify, type JevCacheKey } from './jev-cache.js';
import type { JevAnswer } from './jev.js';

const roots: string[] = [];
const day = 24 * 60 * 60 * 1000;
const answer: JevAnswer = { type: 'choice', choice: 'slides', probabilities: { slides: 1, markdown: 0 }, confidence: 1 };
const key = (contentHash: string): JevCacheKey => ({ questionFamily: 'loader', questionVersion: '1', contentHash });

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-jev-cache-'));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('JevCache', () => {
  it('uses every key part and persists answers per canvas', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    const input = { ...key('hash-a'), extraKey: 'query-a' };
    cache.set(input, answer);
    await cache.save();

    const reloaded = await JevCache.load(directory, 'canvas-one');
    expect(reloaded.get(input)).toEqual(answer);
    expect(reloaded.get({ ...input, questionFamily: 'purpose' })).toBeUndefined();
    expect(reloaded.get({ ...input, questionVersion: '2' })).toBeUndefined();
    expect(reloaded.get({ ...input, contentHash: 'hash-b' })).toBeUndefined();
    expect(reloaded.get({ ...input, extraKey: 'query-b' })).toBeUndefined();
    expect((await JevCache.load(directory, 'canvas-two')).get(input)).toBeUndefined();

    const stored = JSON.parse(await readFile(path.join(directory, 'jev-cache', 'canvas-one.json'), 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(stored.entries)).toEqual([jevCacheKey(input)]);
  });

  it('expires entries after 30 days even when they were read recently', async () => {
    const directory = await root();
    let now = 10 * day;
    const cache = await JevCache.load(directory, 'canvas-one', () => now);
    cache.set(key('hash-a'), answer);
    now += 29 * day;
    expect(cache.get(key('hash-a'))).toEqual(answer);
    now += day;
    expect(cache.get(key('hash-a'))).toBeUndefined();
    await cache.save();
    expect((await JevCache.load(directory, 'canvas-one', () => now)).get(key('hash-a'))).toBeUndefined();
  });

  it('caps entries at 5000 and evicts the least recently used', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one', () => 1_000);
    for (let index = 0; index < 5_000; index++) cache.set(key(`hash-${index}`), answer);
    expect(cache.get(key('hash-0'))).toEqual(answer);
    cache.set(key('hash-5000'), answer);
    expect(cache.get(key('hash-1'))).toBeUndefined();
    expect(cache.get(key('hash-0'))).toEqual(answer);
    expect(cache.get(key('hash-5000'))).toEqual(answer);
    await cache.save();
    const stored = JSON.parse(await readFile(path.join(directory, 'jev-cache', 'canvas-one.json'), 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(stored.entries)).toHaveLength(5_000);
  });

  it('treats a corrupt cache file as a miss and repairs it on save', async () => {
    const directory = await root();
    const cachePath = path.join(directory, 'jev-cache', 'canvas-one.json');
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{broken');
    const cache = await JevCache.load(directory, 'canvas-one');
    expect(cache.get(key('hash-a'))).toBeUndefined();
    cache.set(key('hash-a'), answer);
    await cache.save();
    expect((await JevCache.load(directory, 'canvas-one')).get(key('hash-a'))).toEqual(answer);
  });

  it('rejects invalid canvas IDs before making a path', async () => {
    const directory = await root();
    await expect(JevCache.load(directory, '../outside')).rejects.toThrow('Invalid canvas ID');
  });

  it('stores only answer fields, without unrelated private data', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    cache.set(key('hash-a'), { ...answer, apiKey: 'private-key' } as JevAnswer);
    await cache.save();
    const file = await readFile(path.join(directory, 'jev-cache', 'canvas-one.json'), 'utf8');
    expect(file).not.toContain('private-key');
    expect((await JevCache.load(directory, 'canvas-one')).get(key('hash-a'))).toEqual(answer);
  });

  it('changes the cache key hash when the question criteria change, invalidating the entry', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    const oldQuestion = { type: 'choice' as const, instructions: 'Pick', criteria: { slides: 'Slides', markdown: 'Markdown' } };
    const newQuestion = { type: 'choice' as const, instructions: 'Pick', criteria: { slides: 'Slides', markdown: 'Markdown changed' } };
    const withOld = { ...key('hash-a'), question: oldQuestion };
    cache.set(withOld, answer);
    expect(cache.get(withOld)).toEqual(answer);
    expect(cache.get({ ...key('hash-a'), question: newQuestion })).toBeUndefined();
    expect(jevCacheKey(withOld)).not.toBe(jevCacheKey({ ...key('hash-a'), question: newQuestion }));
  });

  it('drops a cached choice that is no longer among the current criteria', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    const question = { type: 'choice' as const, instructions: 'Pick', criteria: { a: 'A', b: 'B' } };
    const withQuestion = { ...key('hash-a'), question };
    cache.set(withQuestion, { type: 'choice', choice: 'c', probabilities: { a: 0.1, b: 0.1, c: 0.8 }, confidence: 0.9 });
    expect(cache.get(withQuestion)).toBeUndefined();
    // The entry was dropped, not merely hidden: it does not survive a save/reload either.
    await cache.save();
    expect((await JevCache.load(directory, 'canvas-one')).get(withQuestion)).toBeUndefined();
  });

  it('drops a cached score outside the current number of levels', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    const question = { type: 'score' as const, instructions: 'Rate', criteria: ['Low', 'High'] };
    const withQuestion = { ...key('hash-a'), question };
    cache.set(withQuestion, { type: 'score', score: 5, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.9 });
    expect(cache.get(withQuestion)).toBeUndefined();
  });

  it('drops a cached answer whose type no longer matches the question type', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    const question = { type: 'noul' as const, instructions: 'Is it true?' };
    const withQuestion = { ...key('hash-a'), question };
    cache.set(withQuestion, { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 });
    expect(cache.get(withQuestion)).toBeUndefined();
  });

  it('leaves entries without a question unaffected, for backward compatibility', async () => {
    const directory = await root();
    const cache = await JevCache.load(directory, 'canvas-one');
    cache.set(key('hash-a'), answer);
    expect(cache.get(key('hash-a'))).toEqual(answer);
  });
});

describe('stableStringify', () => {
  it('sorts object keys so key order does not affect the result', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively inside arrays and nested objects', () => {
    expect(stableStringify({ z: [{ y: 1, x: 2 }], a: 1 })).toBe('{"a":1,"z":[{"x":2,"y":1}]}');
  });

  it('omits undefined values the same way JSON.stringify does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});
