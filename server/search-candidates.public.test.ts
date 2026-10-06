import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SearchHit } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';
import { searchCandidates } from './search-candidates.js';
import { atomicJson } from './storage-files.js';
import type { StoredCanvas } from './storage-shapes.js';

let directory: string;
let store: CanvasStore;
let server: Server;
let base: string;
let canvasId: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-search-candidates-'));
  server = await createApiServer({ dataDir: directory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Search API did not bind a TCP port');
  base = `http://127.0.0.1:${address.port}`;
  store = new CanvasStore(directory);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Search corpus' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Search checks' })).id;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

async function httpSearch(query: string): Promise<SearchHit[]> {
  const response = await fetch(base + '/api/search?q=' + encodeURIComponent(query));
  expect(response.status).toBe(200);
  return response.json() as Promise<SearchHit[]>;
}

it('centers a body hit on the saved match after length-changing Unicode case folding', async () => {
  const content = 'İ'.repeat(200) + '\nNeedle retrieval\n' + 'x'.repeat(700);
  const block = await store.createBlock(canvasId, { title: 'Unicode lookup', content });
  const hits = await httpSearch('needle');
  expect(hits).toHaveLength(1);
  expect(hits[0].excerpt).toContain('Needle retrieval');
  expect(hits[0].evidence).toMatchObject({ passage: 'Needle retrieval', passageKind: 'exact', contentHash: block.contentHash });
  expect(await readFile(path.join(directory, block.file), 'utf8')).toBe(content);
});

it.each([
  ['abcedf', true], ['abcdeg', true], ['xbcdef', true], ['abccdef', true], ['abcdefg', true], ['abcdf', true],
  ['abcedx', false], ['abcf', false], ['abcdefgh', false],
])('retrieves a title at the one-edit boundary for %s (matched=%s)', async (query, matched) => {
  const block = await store.createBlock(canvasId, { title: 'abcdef', content: 'Unrelated inventory record' });
  const hits = await httpSearch(query);
  expect(hits.map(hit => hit.blockId)).toEqual(matched ? [block.id] : []);
  if (matched) expect(hits[0].retrieval?.kind).toBe('fuzzy_title');
  expect((await store.getCanvas(canvasId)).blocks[0].title).toBe('abcdef');
});

it('uses a body excerpt when a short exact query has no lexical terms', async () => {
  const block = await store.createBlock(canvasId, { title: 'Quarter results', content: 'The Q1 outcome is ready.' });
  const hits = await httpSearch('Q1');
  expect(hits).toEqual([expect.objectContaining({ blockId: block.id, matchIn: 'body', excerpt: 'The Q1 outcome is ready.',
    retrieval: { kind: 'exact', matchedTerms: [] }, evidence: expect.objectContaining({ passageKind: 'exact' }) })]);
});

it('preserves phrase substring matching even when the phrase has no whole-word query terms', async () => {
  const block = await store.createBlock(canvasId, { title: 'preinstall testcase', content: 'Inventory description' });
  const hits = await httpSearch('please install test');
  expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: block.id,
    retrieval: { kind: 'phrase', matchedTerms: [] }, matchIn: 'title' })]));
});

it('keeps stable document-ID ordering for tied names and titles and omits evidence with an invalid timestamp', async () => {
  const first = await store.createBlock(canvasId, { title: 'UniqueNeedle reference', content: 'First record' });
  const second = await store.createBlock(canvasId, { title: 'UniqueNeedle reference', content: 'Second record' });
  const ids = [first.id, second.id].sort((a, b) => a.localeCompare(b));
  expect((await httpSearch('uniqueneedle')).map(hit => hit.blockId)).toEqual(ids);
  const canvas = await new CanvasStore(directory).getCanvas(canvasId);
  const noEvidence = searchCandidates([canvas], 'uniqueneedle', { checkedAt: 'invalid-timestamp' });
  expect(noEvidence.map(hit => hit.blockId)).toEqual(ids);
  expect(noEvidence.every(hit => hit.evidence === undefined)).toBe(true);
  expect(searchCandidates([canvas], '  \n  ')).toEqual([]);
  expect(searchCandidates([canvas], 'uniqueneedle', { limit: -1 })).toHaveLength(1);
  expect(searchCandidates([canvas], 'uniqueneedle', { limit: 1.9 })).toHaveLength(1);
});

it('centers title, fuzzy and long-body passages at original Unicode positions and preserves supplementary characters', async () => {
  const title = 'İ'.repeat(20) + ' Needle ' + 'x'.repeat(30);
  const block = await store.createBlock(canvasId, { title, content: 'Description' });
  const canvas = await store.getCanvas(canvasId);
  expect(searchCandidates([canvas], 'needle')[0]).toMatchObject({ blockId: block.id, excerpt: expect.stringContaining('Needle') });
  const fuzzy = await store.createBlock(canvasId, { title: 'İ catalogue', content: 'Description' });
  expect((await httpSearch('catlogue')).find(hit => hit.blockId === fuzzy.id)?.excerpt).toContain('catalogue');
  const body = 'İ'.repeat(200) + '😀 Needle retrieval ' + 'x'.repeat(700);
  await store.updateBlock(canvasId, block.id, { title: 'Unicode document', content: body });
  const updated = (await httpSearch('needle'))[0];
  expect(updated.excerpt).toContain('😀 Needle retrieval');
  expect(updated.evidence?.passage).toContain('Needle retrieval');
  expect(updated.evidence?.passageKind).toBe('approximation');
  expect(await readFile(path.join(directory, block.file), 'utf8')).toBe(body);
});

async function importSearchCorpus() {
  const seed = await store.createBlock(canvasId, { title: 'UniqueNeedle 00', content: 'Inventory record' });
  const file = path.join(directory, 'canvases', canvasId + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  // Search consumes saved Markdown and canvas metadata. Import the remaining
  // corpus together, retaining a genuinely created document and its Git history.
  const imported = Array.from({ length: 42 }, (_, index) => {
    const id = randomUUID();
    return { ...saved.blocks[0], id, file: `docs/${id}.md`, x: (index + 1) * 450,
      title: `UniqueNeedle ${String(index + 1).padStart(2, '0')}` };
  });
  await Promise.all(imported.map(block => writeFile(path.join(directory, block.file), seed.content)));
  await atomicJson(file, { ...saved, blocks: [...saved.blocks, ...imported] });
  return seed;
}

it('applies the default 40-result cap to saved documents and repeats the same ordering after reload', async () => {
  const seed = await importSearchCorpus();
  const first = await httpSearch('uniqueneedle');
  expect(first).toHaveLength(40);
  expect(first.map(hit => hit.title)).toEqual(Array.from({ length: 40 }, (_, index) => `UniqueNeedle ${String(index).padStart(2, '0')}`));
  const restarted = new CanvasStore(directory);
  expect((await restarted.search('uniqueneedle')).map(hit => hit.blockId)).toEqual(first.map(hit => hit.blockId));
  const snapshot = await restarted.getCanvas(canvasId);
  expect(snapshot.blocks).toHaveLength(43);
  expect(new Set(snapshot.blocks.map(block => block.id)).size).toBe(43);
  expect(await Promise.all(snapshot.blocks.map(block => readFile(path.join(directory, block.file), 'utf8')))).toEqual(Array(43).fill(seed.content));
  expect((await restarted.documentHistory(canvasId, seed.id)).commits[0].message).toBe('Create UniqueNeedle 00');
  expect(searchCandidates([snapshot], 'uniqueneedle', { limit: 100 })).toHaveLength(43);
});
