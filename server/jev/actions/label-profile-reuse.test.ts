import { expect, it, vi } from 'vitest';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevDecider } from '../../jev.js';
import { label } from './profile.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';

function fixture(raw = .8) {
  const document: JevInputDocument = { canvasId: 'canvas', block: { id: 'source', file: 'source.md', title: 'Typography', kind: 'markdown',
    content: '# Typography\nTypography uses readable sizes and consistent spacing.', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source', incarnation: 'native', sourceGeneration: 1, metadataRevision: 1, contentHash: 'source-v1' } };
  const start = document.block.content.indexOf('Typography uses');
  const evidence = { source: { ...document.snapshot }, start, end: document.block.content.length, quote: document.block.content.slice(start) };
  const index = { version: 1, calibration: 1, source: { ...document.snapshot }, topics: [{ name: 'Typography', confidence: .76, evidence: [evidence] }], decisions: [] as Array<{ name: string; confidence: number }> };
  const decider = vi.fn<JevDecider>(async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: raw }];
    if (question.type !== 'choice') throw new Error('Unexpected label question');
    return [id, { type: 'choice', choice: 'p1', confidence: .99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'p1')])) }];
  })));
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [document], canvases: [{ id: 'canvas', name: 'Brand' }],
    settings: emptyJevWorkspace().settings, vocabulary: [], tasks: [], confidenceThreshold: .7, apiKey: 'fixture', decider,
    indexes: { 'canvas:source': index } };
  const request = { action: 'label' as const, canvasId: 'canvas', blockIds: ['source'] };
  return { document, context, index, evidence, decider, request };
}
it('reuses calibrated profile topics for the same exact document body without another provider call', async () => {
  const input = fixture();
  const result = await label(input.context, input.request);
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]).toMatchObject({ mutation: { kind: 'document', patch: { tags: ['Typography'] } },
    decisionConfidences: [.76], sources: [input.document.snapshot], evidence: [input.evidence] });
});
it.each(['contentHash', 'sourceGeneration', 'incarnation'] as const)('rejudges topics after the document %s changes', async field => {
  const input = fixture();
  if (field === 'sourceGeneration') input.document.snapshot.sourceGeneration++;
  else input.document.snapshot[field] += '-changed';
  expect((await label(input.context, input.request)).proposals).toHaveLength(1);
  expect(input.decider).toHaveBeenCalledOnce();
});
it('does not treat unmarked legacy confidence or a corrupted quote as fresh calibrated evidence', async () => {
  for (const reason of ['legacy', 'quote', 'bounds'] as const) {
    const input = fixture();
    if (reason === 'legacy') input.index.calibration = 0;
    else if (reason === 'bounds') input.index.topics[0].evidence[0].end++;
    else input.index.topics[0].evidence[0].quote = 'Invented quotation';
    await label(input.context, input.request);
    expect(input.decider).toHaveBeenCalledOnce();
  }
});
it('rebases still-valid body evidence to the current metadata revision', async () => {
  const input = fixture(); input.document.snapshot.metadataRevision++;
  const result = await label(input.context, input.request);
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.proposals[0].evidence[0].source).toEqual(input.document.snapshot);
});
it.each([[.12, false], [.15, true]] as const)('removes existing labels only when calibrated rejection passes the active slider at raw %s', async (raw, retained) => {
  const input = fixture(raw); input.document.block.tags = ['Unrelated']; input.context.indexes = {};
  input.context.vocabulary = [{ id: 'existing', kind: 'label', name: 'Unrelated', definition: 'An unrelated topic', aliases: [], state: 'active', version: 1, members: [] }];
  const result = await label(input.context, input.request);
  expect(input.decider).toHaveBeenCalledOnce();
  if (retained) expect(result.proposals).toEqual([]);
  else {
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: [] } });
    expect(result.proposals[0].decisionConfidences?.every(value => value >= .7)).toBe(true);
  }
});
it('caps reused labels at twenty and preserves explicit removal and retired vocabulary decisions', async () => {
  const input = fixture();
  input.index.topics = Array.from({ length: 25 }, (_, i) => ({ name: `Topic ${i}`, confidence: .8, evidence: [input.evidence] }));
  input.document.block.content = input.evidence.quote;
  input.evidence.start = 0; input.evidence.end = input.document.block.content.length;
  input.document.block.jevOwnership = { pins: [], managed: ['tags'], removedLabels: ['Topic 0'], removedLinks: [] };
  input.context.vocabulary = [{ id: 'retired', kind: 'label', name: 'Topic 1', definition: 'Retired topic', aliases: [], state: 'retired', version: 1, members: [] }];
  const result = await label(input.context, input.request);
  const mutation = result.proposals[0].mutation;
  expect(mutation).toMatchObject({ kind: 'document', patch: { tags: Array.from({ length: 20 }, (_, i) => `Topic ${i + 2}`) } });
  expect(input.decider).not.toHaveBeenCalled();
});

it('uses fresh accepted topics without judging extra headings or existing tags', async () => {
  const input = fixture();
  input.document.block.tags = ['Owner tag'];
  input.document.block.content += '\n## New nomination';
  const result = await label(input.context, input.request);
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: ['Owner tag', 'Typography'] } });
});
it('makes no provider call when a valid fresh profile accepted no topics', async () => {
  const input = fixture(); input.index.topics = [];
  expect((await label(input.context, input.request)).proposals).toEqual([]);
  expect(input.decider).not.toHaveBeenCalled();
});
it('rejudges a changed vocabulary definition and keeps the stricter slider for reused topics', async () => {
  const input = fixture();
  input.context.vocabulary = [{ id: 'type', kind: 'label', name: 'Typography', definition: 'A new restricted scope', aliases: [], state: 'active', version: 2, members: [] }];
  await label(input.context, input.request); expect(input.decider).toHaveBeenCalledOnce();
  const strict = fixture(); strict.context.confidenceThreshold = .9;
  expect((await label(strict.context, strict.request)).proposals).toEqual([]);
  expect(strict.decider).not.toHaveBeenCalled();
});

it.each([[.28, false], [.35, true]] as const)('uses a fresh profile rejection at calibrated confidence %s without another provider call', async (confidence, retained) => {
  const input = fixture(); input.document.block.tags = ['Old subject'];
  input.index.decisions = [{ name: 'Old subject', confidence }];
  const result = await label(input.context, input.request);
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: retained ? ['Old subject', 'Typography'] : ['Typography'] } });
});

it('removes a rejected old label from a fresh empty profile without guessing from absent topics or calling Jev', async () => {
  const input = fixture();
  input.index.topics = [];
  input.index.decisions = [{ name: 'Old subject', confidence: .2 }];
  input.document.block.tags = ['Old subject', 'Unjudged owner tag'];
  const result = await label(input.context, input.request);
  expect(input.decider).not.toHaveBeenCalled();
  expect(result.result.calibration).toBe(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: ['Unjudged owner tag'] } });
  expect(result.proposals[0].decisionConfidences).toEqual([.8]);
});
