import { expect, it } from 'vitest';
import type { SymbiPassage } from '../../shared/symbi-contract.js';
import type { JevEvaluationContext, JevInputDocument } from './actions/context.js';
import { attachIndexedNeighbors } from './runtime-neighbors.js';

const workspaceId = 'offline-workspace';
function document(canvasId: string, blockId: string, options: { workspaceId?: string; archived?: boolean;
  processingExcluded?: boolean } = {}): JevInputDocument {
  return { canvasId, block: { id: blockId, archived: options.archived, processingExcluded: options.processingExcluded },
    snapshot: { workspaceId: options.workspaceId ?? workspaceId, canvasId, blockId, contentHash: `hash-${blockId}` } } as JevInputDocument;
}
function passage(document: JevInputDocument, score?: number): SymbiPassage {
  return { canvasId: document.canvasId, blockId: document.block.id, contentHash: document.snapshot.contentHash,
    excerpt: document.block.id, startOffset: 0, endOffset: 1, ...(score === undefined ? {} : { score }) };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId, documents } as JevEvaluationContext;
}

it('accepts only distinct current visible positive-score neighbors from the same workspace', async () => {
  const source = document('canvas', 'source'); const valid = document('canvas', 'valid');
  const foreign = document('other', 'foreign', { workspaceId: 'another-workspace' });
  const archived = document('canvas', 'archived', { archived: true });
  const excluded = document('canvas', 'excluded', { processingExcluded: true });
  const current = context([source, valid, foreign, archived, excluded]);
  const candidates = [passage(source, 1), passage(valid, 0), passage(valid, -1),
    { ...passage(valid, 1), contentHash: 'stale-hash' }, passage(foreign, 1), passage(archived, 1),
    passage(excluded, 1), { ...passage(valid, 1), blockId: 'not-visible' }, passage(valid), passage(valid, 1)];
  await attachIndexedNeighbors(current, { action: 'link', canvasId: 'canvas', blockIds: [source.block.id] },
    async () => candidates);
  expect(current.retrievedNeighbors).toEqual({ 'canvas:source': ['canvas:valid'] });
});

it('falls back to empty candidates when retrieval fails and skips actions without an index hook', async () => {
  const source = document('canvas', 'source'); const current = context([source]);
  await attachIndexedNeighbors(current, { action: 'profile', canvasId: 'canvas', blockIds: [source.block.id] },
    async () => { throw new Error('Offline index unavailable'); });
  expect(current.retrievedNeighbors).toEqual({ 'canvas:source': [] });
  const untouched = context([source]);
  await attachIndexedNeighbors(untouched, { action: 'file', canvasId: 'canvas' }, async () => [passage(source, 1)]);
  expect(untouched.retrievedNeighbors).toBeUndefined();
  await attachIndexedNeighbors(untouched, { action: 'link', canvasId: 'canvas' });
  expect(untouched.retrievedNeighbors).toBeUndefined();
});
