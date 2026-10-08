import { expect, it } from 'vitest';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { file } from './profile.js';

type Wire = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
function rootFixture(purpose: number, evidence = 'p2') {
  const block = { id: 'search', title: 'Search retrieval', file: 'search.md', kind: 'markdown' as const,
    content: '# Search retrieval\n\nSearch ranks documents by lexical and semantic relevance before returning matching passages.\n\nThe result link opens a document on its canvas.',
    incarnation: 'search-incarnation', sourceGeneration: 1, metadataRevision: 1,
    x: 0, y: 0, width: 400, height: 300, links: [] };
  const source: JevInputDocument = { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
  const calls: Wire[] = [];
  const context: JevEvaluationContext = { workspaceId: 'workspace', documents: [source], vocabulary: [], tasks: [],
    canvases: [{ id: 'canvas', name: 'Projects', groups: [{ id: 'custom:canvas', name: 'Canvas',
      definition: 'Canvas presentation, spatial layout, navigation, and rendering. Exclude retrieval and search ranking.' }] }],
    settings: emptyJevWorkspace().settings, apiKey: 'offline-root-purpose',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire; calls.push(wire);
      return Response.json({ answers: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        const name = id.split('__').at(-1)!;
        const selected = ['place', 'gate'].includes(name) ? 'A' : name === 'evidence' ? evidence : 'none';
        const answer: JevAnswer = question.type === 'choice' ? { type: 'choice', choice: selected, confidence: .99,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) }
          : { type: 'noul', noul: name.startsWith('purpose_') ? purpose : .99 };
        return [id, answer];
      })) });
    }, options) };
  return { source, context, calls };
}

it('rejects an existing root selected from an incidental canvas mention when the exact main-purpose judgment rejects it', async () => {
  const f = rootFixture(.1);
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['search'] });
  expect(result.proposals).toEqual([]);
  const purpose = f.calls.find(call => Object.hasOwn(call.questions, 'purpose_2'))!;
  expect(purpose.state.selectedGroup).toMatchObject({ key: 'custom:canvas',
    definition: expect.stringContaining('Exclude retrieval and search ranking') });
  expect(purpose.state.localEvidence).toEqual(expect.arrayContaining([expect.objectContaining({
    quote: 'The result link opens a document on its canvas.' })]));
  expect(Object.keys(purpose.questions)).toEqual(['purpose_2']);
  expect(purpose.questions.purpose_2.instructions).toContain("document's main subject");
  expect(f.source.block).not.toHaveProperty('group');
});

it.each([[.69, false], [.7, true]] as const)('uses the unchanged .70 semantic cutoff for existing root purpose (%s)', async (purpose, accepted) => {
  const f = rootFixture(purpose, 'p1');
  const result = await file(f.context, { action: 'file', canvasId: 'canvas', blockIds: ['search'] });
  const membership = result.proposals.find(proposal => proposal.mutation.kind === 'document');
  expect(Boolean(membership)).toBe(accepted);
  if (accepted) {
    expect(membership!.sources).toEqual([f.source.snapshot]);
    expect(membership!.evidence).toEqual([filingPassages(f.source)[1]]);
    expect(membership!.decisionConfidences).toEqual([1, .7]);
    expect(Object.keys(f.calls[2].questions)).toEqual(['purpose_1']);
  }
});
