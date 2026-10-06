import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CanvasBlock, SearchHit } from '../shared/types.js';
import { createApiServer } from './index.js';
import { CanvasStore } from './storage.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('preserves lexical Unicode excerpts and ordering through native HTTP, repeated searches, edits and restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'allteam-search-native-'));
  const api = await createApiServer({ dataDir: directory });
  const base = await listen(api);
  try {
    const store = new CanvasStore(directory);
    await store.init();
    const workspace = await store.createWorkspace({ name: 'Search corpus' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Search checks' });
    const blocks: CanvasBlock[] = [];
    for (const letter of ['A', 'B', 'C', 'D', 'E']) blocks.push(await store.createBlock(canvas.id, {
      title: `Candidate ${letter}`, content: 'İ'.repeat(200) + '\nUniqueNeedle retrieval\n' + 'x'.repeat(700),
    }));
    const search = async (suffix = ''): Promise<SearchHit[]> => {
      const response = await fetch(base + '/api/search?q=uniqueneedle' + suffix);
      expect(response.status).toBe(200);
      return response.json() as Promise<SearchHit[]>;
    };
    const hits = await search();
    expect(hits.map(hit => hit.title)).toEqual(['Candidate A', 'Candidate B', 'Candidate C', 'Candidate D', 'Candidate E']);
    expect(hits.every(hit => hit.excerpt.includes('UniqueNeedle retrieval'))).toBe(true);
    expect((await search()).map(hit => hit.blockId)).toEqual(hits.map(hit => hit.blockId));
    // A stale browser's removed rank option cannot turn ordinary search into a decision-provider call.
    expect((await search('&rank=jev')).map(hit => hit.blockId)).toEqual(hits.map(hit => hit.blockId));
    await expect(readFile(path.join(directory, 'jev-cache', canvas.id + '.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await store.updateBlock(canvas.id, blocks[0].id, { content: 'Updated UniqueNeedle retrieval after review.' });
    const edited = (await search()).find(hit => hit.blockId === blocks[0].id)!;
    expect(edited.excerpt).toContain('Updated UniqueNeedle retrieval');
    expect(await readFile(path.join(directory, blocks[0].file), 'utf8')).toBe('Updated UniqueNeedle retrieval after review.');
    const restarted = new CanvasStore(directory);
    expect(edited.evidence?.contentHash).toBe((await restarted.getCanvas(canvas.id)).blocks[0].contentHash);
    expect((await restarted.search('uniqueneedle')).map(hit => hit.blockId)).toEqual((await search()).map(hit => hit.blockId));
    const missing = await fetch(base + '/api/chat/intents', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: canvas.id, action: 'merge documents', blockIds: blocks.slice(0, 2).map(block => block.id) }) });
    expect(missing.status).toBe(404);
    expect((await restarted.getCanvas(canvas.id)).blocks).toHaveLength(5);
  } finally {
    await close(api);
    await rm(directory, { recursive: true, force: true });
  }
});
