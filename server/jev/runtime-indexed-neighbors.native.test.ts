import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { link } from './actions/graph.js';
import { relevantNeighbors } from './actions/candidates.js';
import { JevRuntime } from './runtime.js';

function offlineAnswer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .99 };
  if (question.type === 'score') return { type: 'score', score: question.criteria.length - 1, confidence: .99,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === question.criteria.length - 1 ? 1 : 0])) };
  const keys = Object.keys(question.criteria); const choice = keys[0];
  return { type: 'choice', choice, confidence: .99,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) };
}

it('passes current authorized local-index nominations to the directed link assessment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-indexed-neighbor-'));
  let runtime: JevRuntime | undefined;
  try {
    const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    const workspaceId = (await store.createWorkspace({ name: 'Indexed candidates' })).id;
    const canvasId = (await store.createCanvas(workspaceId, { name: 'Operations' })).id;
    const source = await store.createBlock(canvasId, { title: 'Closeout protocol', content: 'Disconnect the valve after pressure falls.' });
    const target = await store.createBlock(canvasId, { title: 'End process', content: 'Terminate flow when the gauge drops.' });
    let indexed = 0; let checked = false;
    runtime = new JevRuntime(store, { startTimer: false, apiKey: '', evaluate: async (context, request) => {
      const current = context.documents.find(document => document.block.id === source.id)!;
      if (request.action === 'link' && request.blockIds?.includes(source.id)) {
        checked = true;
        expect(relevantNeighbors({ ...context, retrievedNeighbors: undefined }, current)).toEqual([]);
        expect(relevantNeighbors(context, current).map(document => document.block.id)).toEqual([target.id]);
      }
      return link(context, request);
    }, decider: async (_key, _state, questions) => Object.fromEntries(Object.entries(questions)
      .map(([id, question]) => [id, offlineAnswer(question)])),
    retrieveNeighbors: async (_context, candidate) => {
      indexed += 1;
      if (candidate.block.id !== source.id) return [];
      return [{ canvasId, blockId: target.id, contentHash: 'stale', startOffset: 0, endOffset: 8, excerpt: 'obsolete', score: 1 },
        { canvasId, blockId: target.id, contentHash: target.contentHash!, startOffset: 0, endOffset: 8,
          excerpt: 'Terminate', score: 1 }];
    } });
    await runtime.idle();
    runtime.useTransport({ apiKey: 'offline-only' });
    const owner = { id: 'owner', kind: 'user' as const, access: 'write' as const, canApprove: true };
    const job = await runtime.run(workspaceId, { action: 'link', canvasId, blockIds: [source.id] }, owner);
    await runtime.idle();
    const state = await runtime.read(workspaceId, owner);
    const completed = state.jobs.find(item => item.id === job.id);
    expect(indexed).toBeGreaterThan(0); expect(checked).toBe(true);
    expect(completed).toMatchObject({ state: 'completed', result: { candidateOptions: [
      { sourceId: source.id, targetId: target.id, targetCanvasId: canvasId, origin: 'shared_index' } ] } });
  } finally { await runtime?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
