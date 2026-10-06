import { expect, it } from 'vitest';
import type { JevValues } from '../../shared/jev-types.js';
import { JEV_QUESTION_VERSION, json, type JevInputDocument } from './actions/context.js';
import { currentDocumentIndexes } from './document-index.js';
import { emptyJevWorkspace } from './workspace.js';

function document(id = 'source'): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id,
    incarnation: `inc-${id}`, sourceGeneration: 3, metadataRevision: 4, contentHash: `hash-${id}` },
  block: { id, title: 'Storage', content: '# Storage\nStorage preserves exact source history.', file: `${id}.md`,
    kind: 'markdown', x: 10, y: 20, width: 400, height: 300, links: [] } };
}
function fixture() {
  const source = document(); const state = emptyJevWorkspace();
  const evidence = { source: source.snapshot, start: 10, end: source.block.content.length, quote: source.block.content.slice(10) };
  const logicalIndex: JevValues = { version: 1, topics: [{ name: 'Storage', confidence: .93, evidence: [json(evidence)] }] };
  const key = `${source.canvasId}:${source.block.id}`;
  state.profiles[key] = { questionVersion: JEV_QUESTION_VERSION, source: json(source.snapshot), logicalIndex };
  return { source, state, key, logicalIndex };
}

it('projects the exact current validated index without changing saved source evidence or profile history', () => {
  const { source, state, key, logicalIndex } = fixture(); const before = structuredClone(state);
  expect(currentDocumentIndexes(state, [source])).toEqual({ [key]: logicalIndex });
  expect(state).toEqual(before);
});

it.each([
  ['workspaceId', 'another-workspace'], ['canvasId', 'another-canvas'], ['blockId', 'another-document'],
  ['incarnation', 'replacement'], ['sourceGeneration', 4], ['contentHash', 'changed-content'],
] as const)('rejects an index whose recorded %s differs from the current source', (field, value) => {
  const { source, state, key } = fixture();
  (state.profiles[key].source as JevValues)[field] = value;
  expect(currentDocumentIndexes(state, [source])).toEqual({});
});

it.each(['previous-question-program', undefined])('rejects an index from an outdated or missing question version %s', version => {
  const { source, state, key } = fixture();
  if (version === undefined) delete state.profiles[key].questionVersion;
  else state.profiles[key].questionVersion = version;
  expect(currentDocumentIndexes(state, [source])).toEqual({});
});

it('retains the content index after metadata-only changes without restamping its evidence', () => {
  const { source, state, key, logicalIndex } = fixture();
  source.snapshot.metadataRevision += 1; source.block.group = 'custom:manually-chosen'; source.block.tags = ['Manual'];
  expect(currentDocumentIndexes(state, [source])).toEqual({ [key]: logicalIndex });
  expect((state.profiles[key].source as JevValues).metadataRevision).toBe(4);
});

it.each(['archived', 'processingExcluded'] as const)('omits %s documents even when their indexes are otherwise current', field => {
  const { source, state } = fixture(); source.block[field] = true;
  expect(currentDocumentIndexes(state, [source])).toEqual({});
});

it('never projects an indexed document outside the supplied visible source set', () => {
  const { source, state, key, logicalIndex } = fixture();
  const hidden = document('hidden');
  state.profiles['canvas:hidden'] = { source: json(hidden.snapshot), questionVersion: JEV_QUESTION_VERSION,
    logicalIndex: { version: 1, topics: [{ name: 'Private topic', confidence: .99, evidence: [] }] } };
  expect(currentDocumentIndexes(state, [source])).toEqual({ [key]: logicalIndex });
  expect(JSON.stringify(currentDocumentIndexes(state, [source]))).not.toContain('Private topic');
  expect(currentDocumentIndexes(state, [])).toEqual({});
});

it.each([null, [], { version: 2, topics: [] }, { version: 1 }, { version: 1, topics: 'invalid' }])(
  'omits missing or unsupported index envelopes %j', index => {
    const { source, state, key } = fixture(); state.profiles[key].logicalIndex = json(index);
    expect(currentDocumentIndexes(state, [source])).toEqual({});
  });

it('ignores missing source provenance and unrelated profile-only results', () => {
  const { source, state, key } = fixture(); delete state.profiles[key].source;
  expect(currentDocumentIndexes(state, [source])).toEqual({});
  state.profiles[key] = { questionVersion: JEV_QUESTION_VERSION, source: json(source.snapshot), role: 'reference' };
  expect(currentDocumentIndexes(state, [source])).toEqual({});
});
