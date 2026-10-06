import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { CanvasStore } from '../../storage.js';
import { evaluateJevAction } from '../actions.js';
import { automationPrincipal } from '../authorization.js';
import { evaluationContext } from '../context.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from '../workspace.js';
import { passages, sourceState, type JevEvaluationContext } from './context.js';
import { QuestionAnswerCache } from './question-answer-cache.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Candidate = { name: string; definition: string };
type Source = { id: string; title: string; passages: Array<{ id: string; text: string }>; coverage: number };
type Input = { document: Source; labelCandidates: Candidate[] };
type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
const names = Array.from({ length: 10 }, (_, index) => `Release label ${String(index + 1).padStart(2, '0')}`);
const support = `${names.join(', ')} describe the checked API release workflow and its evidence-backed delivery classifications.`;
const content = `# Release classifications\n${support}\nAlice verifies the current checked release; older metadata cannot replace this source evidence.`;
let root: string; let store: CanvasStore; let files: JevWorkspaceFiles; let workspaceId: string; let request: JevActionRequest;
let server: Server; let origin: string; let cache: QuestionAnswerCache;
let calls: Body[]; let inputs: Input[]; let providerErrors: string[];

function scoped(body: Body, wireId: string) {
  let state = body.state; let id = wireId; let indexed = /^(\d+)__(.+)$/.exec(id);
  while (indexed) {
    state = (state.questionSets as Record<string, unknown>[])[Number(indexed[1])];
    id = indexed[2]; indexed = /^(\d+)__(.+)$/.exec(id);
  }
  return { id, input: resolveSharedQuestionSources(state, body.state.sourceStates) as unknown as Input };
}
function answer(body: Body, wireId: string, submitted: JevQuestion): JevAnswer {
  const { id, input } = scoped(body, wireId);
  const candidate = input.labelCandidates[Number(id.split('_')[1])];
  const question = resolveSharedQuestionTexts(submitted, body.state.questionTexts);
  if (question.type === 'noul') return { type: 'noul', noul: candidate.name === names[6] ? .6 : .98 };
  if (question.type !== 'choice') throw new Error('Labels must retain typed yes/no and exact-passage decisions');
  const selected = candidate.name === names[7] ? 'none' : input.document.passages.find(passage => passage.text.includes('checked API release workflow'))!.id;
  return { type: 'choice', choice: selected, confidence: .51,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) };
}
beforeEach(async () => {
  calls = []; inputs = []; providerErrors = []; cache = new QuestionAnswerCache();
  server = createServer(async (incoming, response) => {
    try {
      let raw = ''; for await (const chunk of incoming) raw += String(chunk);
      const body = JSON.parse(raw) as Body; calls.push(body);
      const decoded = resolveSharedQuestionSources(body.state, body.state.sourceStates);
      inputs.push(...(decoded.questionSets ?? [decoded]) as Input[]);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(body, id, question)]));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ answers }));
    } catch (error) {
      providerErrors.push(String(error)); response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Synthetic provider could not resolve the exact typed input' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native label provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-label-cache-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Exact cached labels' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Release evidence' })).id;
  const block = await store.createBlock(canvasId, { title: 'Release classifications', content, x: 123, y: 456 });
  await store.ensureJevStamps(canvasId);
  request = { action: 'label', canvasId, blockIds: [block.id] }; files = new JevWorkspaceFiles(root);
  const state = emptyJevWorkspace();
  state.vocabulary = names.map((name, index): JevVocabularyTerm => ({ id: `label-${index + 1}`, name, kind: 'label',
    definition: `${name} identifies documents about the checked API release workflow, with exact source-backed classifications.`,
    state: 'active', version: 1, aliases: [], members: [{ canvasId, blockId: block.id }] }));
  await files.write(workspaceId, state);
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  expect(providerErrors).toEqual([]);
});
async function context(): Promise<JevEvaluationContext> {
  const input = await evaluationContext(store, workspaceId, await files.read(workspaceId), request, automationPrincipal, new AbortController().signal);
  return { ...input, apiKey: 'native-label-cache',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
async function evaluated(input: JevEvaluationContext, limit?: number) {
  return evaluateJevAction(cachedQuestionContext({ ...input, prefetchLabelCandidateLimit: limit }, cache, 'exact-native-label-source-policy'), request);
}
function unchangedInput(input: JevEvaluationContext) {
  return structuredClone({ documents: input.documents, vocabulary: input.vocabulary, settings: input.settings });
}
async function changeTerm(index: number, patch: Partial<JevVocabularyTerm>) {
  const state = await files.read(workspaceId); state.vocabulary[index] = { ...state.vocabulary[index], ...patch, version: state.vocabulary[index].version + 1 };
  await files.write(workspaceId, state);
}
function exactProposal(result: Awaited<ReturnType<typeof evaluated>>, input: JevEvaluationContext) {
  expect(result.proposals).toHaveLength(1); const proposal = result.proposals[0]; const source = input.documents[0];
  expect(proposal.sources).toEqual([source.snapshot]);
  expect(proposal.decisionConfidences?.every(confidence => confidence === .98)).toBe(true);
  expect(proposal.evidence.length).toBeGreaterThan(0);
  for (const evidence of proposal.evidence) {
    expect(evidence.source).toEqual(source.snapshot);
    expect(source.block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
  }
  return proposal;
}

it('checks nine exact singleton candidates, then reuses the surviving eight after a canonical retirement and saves current source-backed labels', async () => {
  const original = await context(); const before = unchangedInput(original);
  const first = await evaluated(original, 9);
  expect(calls).toHaveLength(1); expect(inputs.map(input => input.labelCandidates.map(candidate => candidate.name))).toEqual(names.slice(0, 9).map(name => [name]));
  expect(first.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { tags: [...names.slice(0, 6), names[8]] } });
  const wire = calls[0]; const source = sourceState(original.documents[0]);
  expect(wire.state.sourceStates).toEqual([source]);
  expect(JSON.stringify(wire).split(JSON.stringify(source))).toHaveLength(2);
  expect((wire.state.questionSets as Array<{ document: unknown }>).every(set => JSON.stringify(set.document) === '{"$jevSourceRef":0}')).toBe(true);
  expect((wire.state.questionTexts as string[]).length).toBeGreaterThan(0);
  expect(Object.values(wire.questions).some(question => JSON.stringify(question).includes('$jevQuestionText:'))).toBe(true);
  const questions = resolveSharedQuestionTexts(wire.questions, wire.state.questionTexts);
  expect(Object.entries(questions).every(([id, question]) => !id.endsWith('evidence_0') || question.type === 'choice' && Object.values(question.criteria).includes(support))).toBe(true);
  expect(unchangedInput(original)).toEqual(before);
  await changeTerm(0, { state: 'retired' });
  const fresh = await context(); const freshBefore = unchangedInput(fresh); const result = await evaluated(fresh);
  expect(calls).toHaveLength(1); expect(unchangedInput(fresh)).toEqual(freshBefore);
  const proposal = exactProposal(result, fresh);
  expect(proposal.mutation).toMatchObject({ kind: 'document', patch: { tags: [...names.slice(1, 6), names[8]] } });
  const preparedFile = path.join(root, 'label-commit.json');
  await store.jevExecutor.execute(proposal.mutation, proposal.sources, 'native-cached-label-commit', automationPrincipal.id, true,
    async prepared => { await writeFile(preparedFile, JSON.stringify(prepared)); });
  expect(JSON.parse(await readFile(preparedFile, 'utf8')).after).toEqual(proposal.mutation);
  const saved = await new CanvasStore(root).getCanvasBlock(request.canvasId, request.blockIds![0]);
  expect(saved).toMatchObject({ tags: [...names.slice(1, 6), names[8]], content, x: 123, y: 456 });
  expect(saved.contentHash).toBe(original.documents[0].block.contentHash);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).vocabulary[0]).toMatchObject({ state: 'retired', version: 2 });
  expect((await evaluated(await context())).proposals).toEqual([]);
  expect(calls).toHaveLength(1);
});

it('sends only a changed definition or name despite candidate reordering and never mutates the caller vocabulary', async () => {
  await evaluated(await context(), 9); expect(calls).toHaveLength(1);
  const definition = 'The revised checked API release definition requires new exact source-based assessment, rather than reuse of an earlier meaning.';
  await changeTerm(2, { definition }); const revised = await context(); const before = unchangedInput(revised);
  exactProposal(await evaluated(revised), revised); expect(unchangedInput(revised)).toEqual(before);
  expect(calls).toHaveLength(2); expect(inputs.at(-1)!.labelCandidates).toEqual([{ name: names[2], definition }]);
  expect(Object.keys(calls[1].questions)).toEqual(['label_0', 'evidence_0']);
  await changeTerm(1, { name: 'Release label' });
  const renamed = await context(); exactProposal(await evaluated(renamed), renamed);
  expect(calls).toHaveLength(3); expect(inputs.at(-1)!.labelCandidates[0].name).toBe('Release label');
  expect(inputs.slice(9).every(input => input.labelCandidates.length === 1)).toBe(true);
});

it('rejudges edited source text, retains exact current quote bounds and refuses committing stale prefetched evidence', async () => {
  const original = await context(); const oldProposal = exactProposal(await evaluated(original, 9), original);
  const edited = `# A freshly revised release document\nNew instructions precede the evidence.\n${support}\nOnly the new source generation is current.`;
  await store.updateBlock(request.canvasId, request.blockIds![0], { content: edited });
  const fresh = await context(); const result = await evaluated(fresh); const proposal = exactProposal(result, fresh);
  expect(calls).toHaveLength(2); expect(inputs.slice(9)).toHaveLength(8);
  expect(inputs.slice(9).every(input => input.document.passages.some(passage => passage.text === 'New instructions precede the evidence.'))).toBe(true);
  expect(proposal.evidence[0].start).not.toBe(oldProposal.evidence[0].start);
  expect(proposal.evidence[0].quote).toBe(support);
  expect(proposal.evidence[0]).toEqual(passages(fresh.documents[0]).find(passage => passage.quote === support));
  await expect(store.jevExecutor.execute(oldProposal.mutation, oldProposal.sources, 'stale-label-commit', automationPrincipal.id, true, async () => {})).rejects.toMatchObject({ status: 409 });
  expect((await new CanvasStore(root).getCanvasBlock(request.canvasId, request.blockIds![0])).content).toBe(edited);
});

it('retains the manual eight-candidate flat state and keeps low confidence and evidence abstention independent', async () => {
  const input = await context(); const before = unchangedInput(input);
  const result = await evaluateJevAction(input, request); const proposal = exactProposal(result, input);
  expect(calls).toHaveLength(1); expect(inputs).toHaveLength(1);
  expect(inputs[0].labelCandidates.map(candidate => candidate.name)).toEqual(names.slice(0, 8));
  expect(calls[0].state.questionSets).toBeUndefined(); expect(calls[0].state.sourceStates).toBeUndefined();
  expect(Object.keys(calls[0].questions)).toEqual(names.slice(0, 8).flatMap((_, index) => [`label_${index}`, `evidence_${index}`]));
  expect(proposal.mutation).toMatchObject({ kind: 'document', patch: { tags: names.slice(0, 6) } });
  expect(proposal.evidence).toHaveLength(6); expect(unchangedInput(input)).toEqual(before);
  const stricter = await evaluateJevAction({ ...input, settings: { ...input.settings, confidenceThresholds: { label: .99 } } }, request);
  expect(stricter.proposals).toEqual([]); expect(calls).toHaveLength(2);
});
