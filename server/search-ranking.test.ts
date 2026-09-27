import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanvasBlock, CanvasDocument, SearchHit } from '../shared/types.js';
import type { JevAnswer, JevDecider } from './jev.js';
import type { CanvasStore } from './storage.js';
import { rankSearchHits } from './search-ranking.js';

const roots: string[] = [];

function fixture(root: string, count: number) {
  const blocks: CanvasBlock[] = Array.from({ length: count }, (_, index) => ({
    id: `doc-${index}`, title: `Launch ${index}`, file: `doc-${index}.md`, kind: 'markdown',
    content: `# Launch ${index}\nThe launch plan for document ${index}.`, contentHash: `hash-${index}`,
    x: 0, y: 0, width: 400, height: 300, links: [],
  }));
  const hits: SearchHit[] = blocks.map(block => ({ canvasId: 'canvas-a', canvasName: 'Canvas A', blockId: block.id,
    title: block.title, excerpt: block.title, tags: [], kind: 'markdown', matchIn: 'title' }));
  const canvas: CanvasDocument = { id: 'canvas-a', workspaceId: 'workspace-a', name: 'Canvas A', blocks };
  const store = { root, getCanvas: async () => canvas, getJevApiKey: async () => 'test-key' } as unknown as CanvasStore;
  return { store, hits, blocks };
}

function response(questions: Record<string, unknown>, scoreFor: (index: number) => number): Record<string, JevAnswer> {
  return Object.fromEntries(Object.keys(questions).map((id, index) => {
    const score = scoreFor(index);
    return [id, { type: 'score', score, confidence: 1, probabilities: { [score]: 1 } }];
  }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Jev search ranking', () => {
  it('uses expected relevance and caches each document for the query and content hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-rank-'));
    roots.push(root);
    const { store, hits, blocks } = fixture(root, 3);
    const decider: JevDecider = vi.fn(async (_key, state, questions) => {
      expect((state as { query: string }).query).toBe('launch');
      return response(questions, index => [0, 4, 2][index]);
    });
    const ranked = await rankSearchHits(store, 'launch', hits, decider);
    expect(ranked.map(hit => hit.blockId)).toEqual(['doc-1', 'doc-2', 'doc-0']);
    expect((decider as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    expect((await rankSearchHits(store, 'launch', hits, decider)).map(hit => hit.blockId)).toEqual(['doc-1', 'doc-2', 'doc-0']);
    expect((decider as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    blocks[1].contentHash = 'changed-hash';
    await rankSearchHits(store, 'launch', hits, decider);
    expect(Object.keys((decider as ReturnType<typeof vi.fn>).mock.calls[1][2])).toHaveLength(1);
    await rankSearchHits(store, 'different query', hits, decider);
    expect(Object.keys((decider as ReturnType<typeof vi.fn>).mock.calls[2][2])).toHaveLength(3);
  });

  it('reranks only the first 20 hits and leaves the remaining order intact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-rank-'));
    roots.push(root);
    const { store, hits } = fixture(root, 22);
    const decider: JevDecider = async (_key, _state, questions) => response(questions, index => index % 5);
    const ranked = await rankSearchHits(store, 'launch', hits, decider);
    expect(ranked.slice(0, 4).map(hit => hit.blockId)).toEqual(['doc-4', 'doc-9', 'doc-14', 'doc-19']);
    expect(ranked.slice(20).map(hit => hit.blockId)).toEqual(['doc-20', 'doc-21']);
  });

  it('returns original hit order when Jev misses the deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-rank-'));
    roots.push(root);
    const { store, hits } = fixture(root, 3);
    const decider: JevDecider = async () => new Promise<Record<string, JevAnswer>>(() => {});
    expect(await rankSearchHits(store, 'launch', hits, decider, { timeoutMs: 10 })).toBe(hits);
  });

  it('aborts the decider signal when the deadline fires and asks for no retries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-rank-'));
    roots.push(root);
    const { store, hits } = fixture(root, 3);
    let capturedSignal: AbortSignal | undefined;
    const decider: JevDecider = (_key, _state, _questions, _fetcher, options) => {
      capturedSignal = options?.signal;
      expect(options?.maxRetries).toBe(0);
      return new Promise<Record<string, JevAnswer>>(() => {});
    };
    await rankSearchHits(store, 'launch', hits, decider, { timeoutMs: 10 });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('refers to state with a backticked path and marks the hit content as data, not instructions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-search-rank-'));
    roots.push(root);
    const { store, hits } = fixture(root, 1);
    const decider: JevDecider = vi.fn(async (_key, state, questions) => {
      expect(questions.r0.instructions).toContain('`state.hits[0]`');
      expect(questions.r0.instructions).toContain('`state.query`');
      expect(questions.r0.instructions.toLowerCase()).toContain('not instructions');
      return response(questions, () => 2);
    });
    await rankSearchHits(store, 'launch', hits, decider);
    expect(decider).toHaveBeenCalledTimes(1);
  });
});
