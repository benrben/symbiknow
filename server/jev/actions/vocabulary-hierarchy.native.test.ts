import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevQuestion } from '../../jev.js';
import { emptyJevWorkspace } from '../workspace.js';
import { passages, type JevEvaluationContext } from './context.js';
import { resolveSharedQuestionSources } from './question-state-pool.test.helpers.js';
import { groupHierarchy } from './vocabulary-hierarchy.js';

type State = { selectedParent?: { id: string; name: string; definition: string; groupKey: string };
  sources?: Array<{ passages: Array<{ id: string; text: string }> }>; questionSets?: State[]; sharedSources?: unknown };
type Body = { state: State; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string; let calls: Body[];
let parentChoice: string; let parentConfidence: number; let quote: string; let supportedParents: Record<string, number>;
function scoped(body: Body, id: string) {
  const match = /^(\d+)__(.+)$/.exec(id);
  const state = match ? body.state.questionSets![Number(match[1])] : body.state;
  return { name: match?.[2] ?? id, state: resolveSharedQuestionSources(state, body.state.sharedSources) };
}
function answer(body: Body, id: string, question: JevQuestion): JevAnswer {
  const { name, state } = scoped(body, id);
  if (question.type === 'noul') return { type: 'noul', noul: supportedParents[state.selectedParent!.id] ?? 0.98 };
  if (question.type !== 'choice') throw new Error('Unexpected hierarchy score question');
  const choice = name === 'parent' ? parentChoice : quote;
  return { type: 'choice', choice, confidence: name === 'parent' ? parentConfidence : 0.1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) };
}
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body; calls.push(body); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(body, id, question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native hierarchy provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { calls = []; parentChoice = 'parent1'; parentConfidence = 0.98; quote = 'd0p1'; supportedParents = {}; });
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
function term(id: string, patch: Partial<JevVocabularyTerm> = {}): JevVocabularyTerm {
  return { id, name: id, kind: 'group', groupKey: `custom:${id}`, definition: `${id} purpose and source boundaries.`, aliases: [],
    state: 'active', version: 1, members: [], ...patch };
}
function context(): JevEvaluationContext {
  return { workspaceId: 'workspace', canvases: [{ id: 'canvas', name: 'Release' }], tasks: [], vocabulary: [term('commerce'), term('platform')],
    settings: emptyJevWorkspace().settings, apiKey: 'native-parent-hierarchy', decider: (key, state, questions, _fetcher, options) =>
      decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options),
    documents: [{ canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
      incarnation: 'original', sourceGeneration: 1, metadataRevision: 2, contentHash: 'exact-source' },
    block: { id: 'source', title: 'Pilot release', file: 'source.md', kind: 'markdown',
      content: '# Pilot release\r\nPilot is the release subgroup within Platform.\r\n', x: 11, y: 22, width: 400, height: 300, links: [] } }] };
}
const request: JevActionRequest = { action: 'vocab_lifecycle', canvasId: 'canvas', blockIds: ['source'] };
async function inferred(input = context()) { return groupHierarchy(input, request, 'Pilot', input.documents); }

it('shares parent selection and each parent’s own containment/evidence through one native SDK request', async () => {
  const input = context(); const before = structuredClone({ documents: input.documents, vocabulary: input.vocabulary });
  expect(await inferred(input)).toEqual({ parentId: 'platform', groupKey: 'custom:platform/pilot' });
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0].questions)).toEqual(['0__parent', '1__containment', '1__parentEvidence', '2__containment', '2__parentEvidence']);
  expect(scoped(calls[0], '2__containment').state.selectedParent).toEqual({ id: 'platform', name: 'platform',
    definition: 'platform purpose and source boundaries.', groupKey: 'custom:platform' });
  const evidence = calls[0].questions['2__parentEvidence'];
  if (evidence.type !== 'choice') throw new Error('Expected an exact passage choice');
  expect(evidence.criteria.d0p1).toBe('Pilot is the release subgroup within Platform.');
  const exact = passages(input.documents[0])[1];
  expect(input.documents[0].block.content.slice(exact.start, exact.end)).toBe(evidence.criteria.d0p1);
  expect({ documents: input.documents, vocabulary: input.vocabulary }).toEqual(before);
});

it('cannot borrow strong containment from an unselected parent for the unsupported selected parent', async () => {
  supportedParents = { platform: 0.01, commerce: 0.99 };
  expect(await inferred()).toEqual({ groupKey: 'custom:pilot' }); expect(calls).toHaveLength(1);
});
it('keeps a none parent choice at the root even when every precomputed containment is supported', async () => {
  parentChoice = 'none'; expect(await inferred()).toEqual({ groupKey: 'custom:pilot' }); expect(calls).toHaveLength(1);
});
it('keeps an uncertain parent selection at the root despite exact supporting quotes', async () => {
  parentConfidence = 0.4; expect(await inferred()).toEqual({ groupKey: 'custom:pilot' }); expect(calls).toHaveLength(1);
});
it('requires the selected parent’s exact quote and independent containment threshold', async () => {
  quote = 'none'; expect(await inferred()).toEqual({ groupKey: 'custom:pilot' });
  quote = 'd0p1'; const input = context(); input.confidenceThreshold = 0.9; supportedParents.platform = 0.8;
  expect(await inferred(input)).toEqual({ groupKey: 'custom:pilot' });
});
it('bounds inferred parents to sixteen active custom groups below the native depth limit', async () => {
  const input = context(); input.vocabulary = [term('label', { kind: 'label' }), term('retired', { state: 'retired' }),
    term('lane', { groupKey: 'lane:overview' }), term('deep', { groupKey: 'custom:a/b/c/d/e/f/g/h' }),
    ...Array.from({ length: 17 }, (_, index) => term(`parent-${index}`))];
  parentChoice = 'parent15'; expect(await inferred(input)).toEqual({ parentId: 'parent-15', groupKey: 'custom:parent-15/pilot' });
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0].questions)).toHaveLength(33);
  expect(JSON.stringify(calls)).not.toContain('parent-16');
  expect(estimateJevTokens(calls[0].state) + estimateJevTokens(calls[0].questions)).toBeLessThanOrEqual(16000);
});

it('keeps absent inferred parents local without sending source bytes', async () => {
  const input = context(); input.vocabulary = [];
  expect(await inferred(input)).toEqual({ groupKey: 'custom:pilot' }); expect(calls).toEqual([]);
});
it.each([
  [{ parentId: 'platform' }, { parentId: 'platform', groupKey: 'custom:platform/pilot' }],
  [{ groupKey: 'custom:platform/pilot' }, { parentId: 'platform', groupKey: 'custom:platform/pilot' }],
  [{ groupKey: 'custom:independent' }, { groupKey: 'custom:independent' }],
  [{ parentId: 'platform', groupKey: 'custom:platform/explicit' }, { parentId: 'platform', groupKey: 'custom:platform/explicit' }],
])('preserves an explicit hierarchy %s without a provider request', async (options, expected) => {
  const input = context(); expect(await groupHierarchy(input, { ...request, options }, 'Pilot', input.documents)).toEqual(expected);
  expect(calls).toEqual([]);
});
it.each([
  [{ parentId: 'missing' }, 404], [{ groupKey: 'custom:missing/pilot' }, 400],
  [{ groupKey: 'not a native path' }, 400], [{ parentId: 'platform', groupKey: 'custom:commerce/pilot' }, 400],
])('retains explicit parent/path validation for %s', async (options, status) => {
  const input = context(); await expect(groupHierarchy(input, { ...request, options }, 'Pilot', input.documents)).rejects.toMatchObject({ status });
  expect(calls).toEqual([]);
});
it('refuses an explicit inactive parent while preserving legacy root groups with no native groupKey', async () => {
  const input = context(); input.vocabulary[1].state = 'retired';
  await expect(groupHierarchy(input, { ...request, options: { parentId: 'platform' } }, 'Pilot', input.documents)).rejects.toMatchObject({ status: 409 });
  input.vocabulary = [term('legacy', { groupKey: undefined })];
  expect(await groupHierarchy(input, { ...request, options: { parentId: 'legacy' } }, 'Pilot', input.documents))
    .toEqual({ parentId: 'legacy', groupKey: 'custom:legacy/pilot' });
  expect(calls).toEqual([]);
});
