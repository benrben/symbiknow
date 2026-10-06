import { afterEach, expect, it, vi } from 'vitest';
import { groupingSignals, groupingSignalState } from './group-signals.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { emptyJevWorkspace } from '../workspace.js';
import * as visibleSources from './source-passages.js';

function document(id: string, content: string, canvasId = 'canvas'): JevInputDocument {
  return { canvasId, snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: id,
    sourceGeneration: 1, metadataRevision: 1, contentHash: `hash-${id}` }, block: { id, title: id, file: `${id}.md`,
    kind: 'markdown', content, x: 0, y: 0, width: 400, height: 300, links: [] } };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Main' }, { id: 'other', name: 'Other' }],
    tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings };
}
afterEach(() => vi.restoreAllMocks());
it('ranks visible topical overlap without titles, group names, labels or provider decisions', () => {
  const source = document('alpha', 'Database transactions journal recovery durability.');
  const relevant = document('beta', 'Database journal transactions recovery.');
  const unrelated = document('gamma', 'Garden seedlings compost flowers.');
  const input = context([source, unrelated, relevant]);
  const result = groupingSignals(input, source);
  expect(result.indexTerms).toContain('database');
  expect(result.neighbors.map(item => item.document)).toEqual([relevant]);
  expect(result.neighbors[0].indexScore).toBeGreaterThan(.5);
  expect(result.neighbors[0].indexScore).toBeLessThanOrEqual(1);
  expect(result.neighbors[0].document.snapshot).toBe(relevant.snapshot);
});
it('combines normalized shared labels and explicit forward and reverse relationship signals', () => {
  const source = document('alpha', 'Database transaction.'); source.block.tags = ['Platform', ' Platform '];
  const labeled = document('beta', 'Garden seedlings.'); labeled.block.tags = ['platform'];
  const linked = document('gamma', 'Travel luggage.'); source.block.links = [linked.block.id]; source.block.linkTypes = { gamma: 'prerequisite' };
  const reverse = document('delta', 'Music melody.'); reverse.block.links = [source.block.id]; reverse.block.linkTypes = { alpha: 'contradicts' };
  const result = groupingSignals(context([source, labeled, linked, reverse]), source);
  expect(result.neighbors.find(item => item.document === labeled)).toMatchObject({ indexScore: 0, sharedLabels: ['Platform'], relations: [] });
  expect(result.neighbors.find(item => item.document === linked)?.relations).toEqual(['outgoing:prerequisite']);
  expect(result.neighbors.find(item => item.document === reverse)?.relations).toEqual(['incoming:contradicts']);
  expect(result.neighbors.every(item => !('confidence' in item))).toBe(true);
});
it('admits allowed cross-canvas peers only through exact forward or reverse cross-links', () => {
  const source = document('same', 'Database journal recovery.');
  const linked = document('linked', 'Music melody.', 'other');
  const reverse = document('reverse', 'Garden flowers.', 'other');
  const unlinked = document('unlinked', source.block.content, 'other');
  const collision = document('same', source.block.content, 'other');
  source.block.links = ['same'];
  source.block.crossLinks = [{ canvasId: 'other', blockId: 'linked', relation: 'same_topic' }];
  reverse.block.crossLinks = [{ canvasId: 'canvas', blockId: 'same' }];
  const result = groupingSignals(context([source, linked, reverse, unlinked, collision]), source);
  expect(result.neighbors.map(item => item.document.block.id).sort()).toEqual(['linked', 'reverse']);
  expect(result.neighbors.find(item => item.document === linked)?.relations).toEqual(['outgoing:same_topic']);
  expect(result.neighbors.find(item => item.document === reverse)?.relations).toEqual(['incoming:related']);
});
it('excludes foreign, hidden, archived, processing-excluded and mismatched identities from all signals', () => {
  const source = document('source', 'Allowed visible topic.');
  const hidden = document('hidden', 'SECRET_HIDDEN', 'restricted');
  const foreign = document('foreign', 'SECRET_FOREIGN'); foreign.snapshot.workspaceId = 'elsewhere';
  const archived = document('archived', 'SECRET_ARCHIVED'); archived.block.archived = true;
  const excluded = document('excluded', 'SECRET_EXCLUDED'); excluded.block.processingExcluded = true;
  const mismatch = document('mismatch', 'SECRET_MISMATCH'); mismatch.snapshot.canvasId = 'other';
  const input = context([source, hidden, foreign, archived, excluded, mismatch]);
  source.block.crossLinks = [{ canvasId: 'restricted', blockId: 'hidden' }]; source.block.links = ['foreign', 'archived', 'excluded', 'mismatch'];
  expect(groupingSignals(input, source).neighbors).toEqual([]);
  expect(JSON.stringify(groupingSignalState(input, source))).not.toContain('SECRET');
  expect(groupingSignalState(input, hidden)).toEqual({ indexTerms: [], labels: [], logicalIndex: null, neighbors: [] });
});
it('uses only visible HTML prose and returns bounded serializable neighbor metadata without source bodies', () => {
  const source = document('source', '<html><head><style>SECRET_STYLE</style></head><body><script>SECRET_SCRIPT</script><p>Database journal recovery.</p></body></html>');
  source.block.tags = ['Platform'];
  const peers = Array.from({ length: 12 }, (_, index) => document(`peer${index}`, `Database journal recovery. PRIVATE_BODY_${index}`));
  peers[0].block.group = 'custom:platform';
  const result = groupingSignalState(context([source, ...peers]), source);
  expect(result.indexTerms).not.toEqual(expect.arrayContaining(['secret_style', 'secret_script']));
  expect(result.labels).toEqual(['Platform']); expect(result.neighbors).toHaveLength(8);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|SECRET_STYLE|SECRET_SCRIPT|contentHash|incarnation/);
  expect(result.neighbors[0]).toMatchObject({ canvasId: 'canvas', blockId: 'peer0', title: 'peer0', group: 'custom:platform' });
});
it('reuses an exact scoped index and invalidates cached results after in-place content, label, link or scope changes', () => {
  const spy = vi.spyOn(visibleSources, 'sourcePassages');
  const source = document('source', 'Database journal.');
  const peer = document('peer', 'Database journal.');
  const input = context([source, peer]);
  const before = structuredClone(input);
  expect(groupingSignals(input, source).neighbors).toHaveLength(1);
  const firstReads = spy.mock.calls.length;
  groupingSignalState({ ...input, documents: [...input.documents] }, source);
  expect(spy.mock.calls).toHaveLength(firstReads); expect(input).toEqual(before);
  peer.block.content = 'Garden compost.';
  expect(groupingSignals(input, source).neighbors).toEqual([]);
  source.block.tags = ['Shared']; peer.block.tags = ['shared'];
  expect(groupingSignals(input, source).neighbors[0].sharedLabels).toEqual(['Shared']);
  peer.block.tags = []; source.block.links = ['peer'];
  expect(groupingSignals(input, source).neighbors[0].relations).toEqual(['outgoing:related']);
  input.canvases = [];
  expect(groupingSignalState(input, source)).toEqual({ indexTerms: [], labels: [], logicalIndex: null, neighbors: [] });
});
it('retains exact identities after source replacement and does not expose mutable cached result arrays', () => {
  const source = document('source', 'Database journal.'); const peer = document('peer', 'Database journal.');
  const input = context([source, peer]);
  const first = groupingSignals(input, source); first.indexTerms.push('injected'); first.neighbors[0].relations.push('injected');
  const restored = groupingSignals(input, source);
  expect(restored.indexTerms).not.toContain('injected'); expect(restored.neighbors[0].relations).not.toContain('injected');
  const replacement = structuredClone(peer); replacement.snapshot.incarnation = 'replacement'; input.documents[1] = replacement;
  expect(groupingSignals(input, source).neighbors[0].document).toBe(replacement);
});

it('adds checked Jev logical topics independently of lexical overlap and refreshes when index answers change', () => {
  const source = document('source', 'Database journal.'); const peer = document('peer', 'Garden compost.');
  const input = context([source, peer]);
  input.indexes = {
    'canvas:source': { version: 1, topics: [{ name: 'Recovery planning', confidence: .95, evidence: [] }] },
    'canvas:peer': { version: 1, topics: [{ name: 'Recovery planning', confidence: .9, evidence: [] }, { name: 'Unsafe low confidence', confidence: .1 }] },
  };
  const result = groupingSignalState(input, source);
  expect(result.logicalIndex).toEqual({ version: 1, topics: [{ name: 'Recovery planning', confidence: .95 }] });
  expect(result.neighbors[0].logicalTopics).toEqual([{ name: 'Recovery planning', confidence: .9 }]);
  expect(result.indexTerms).toContain('recovery');
  input.indexes['canvas:peer'] = { version: 1, topics: [] };
  expect(groupingSignals(input, source).neighbors).toEqual([]);
});
