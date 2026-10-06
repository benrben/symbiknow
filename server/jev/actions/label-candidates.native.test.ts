import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../../storage.js';
import { JevRuntime } from '../runtime.js';
import { JevWorkspaceFiles, emptyJevWorkspace } from '../workspace.js';
import { automationPrincipal } from '../authorization.js';
import { JEV_QUESTION_VERSION } from '../actions.js';
import { sourceSnapshot } from '../stamps.js';
import type { JevDecider, JevQuestion } from '../../jev.js';
import type { JevVocabularyTerm } from '../../../shared/jev-types.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

type Choice = { name: string; definition: string };
type Input = { document: { id: string; title: string; passages: Array<{ id: string; text: string }> }; labelCandidates: Choice[] };
const opened: Array<{ root: string; runtime: JevRuntime }> = [];
beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); });
afterEach(async () => { for (const value of opened.splice(0)) { await value.runtime.shutdown(); await rm(value.root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });

function answer(id: string, question: JevQuestion, input: Input) {
  if (question.type === 'noul') return { type: 'noul' as const, noul: input.labelCandidates[Number(id.split('_')[1])].name === input.document.title ? 0.98 : 0.01 };
  if (question.type !== 'choice') throw new Error('Label checks must use bounded choices and yes/no decisions');
  const choice = input.document.passages[1].id;
  return { type: 'choice' as const, choice, confidence: 0.98, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) };
}
async function fixture(titles: string[], options: { tags?: string[]; content?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-label-priority-'));
  const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Source labels' }); const canvas = await store.createCanvas(workspace.id, { name: 'Documentation' });
  for (const title of titles) await store.createBlock(canvas.id, { title, content: options.content ?? `# ${title}\n${title} explains the checked release workflow.`, tags: options.tags });
  await store.ensureJevStamps(canvas.id);
  const document = await store.getCanvas(canvas.id, true); const files = new JevWorkspaceFiles(root); const state = emptyJevWorkspace();
  state.vocabulary = document.blocks.map((block, index) => ({ id: `label-${index}`, kind: 'label', name: block.title, definition: `The main subject of ${block.title}.`, aliases: [], state: 'active', version: 1,
    members: [{ canvasId: canvas.id, blockId: block.id }] }));
  await files.write(workspace.id, state);
  const inputs: Input[] = [];
  const decider: JevDecider = async (_key, value, questions) => {
    const wire = value as Record<string, unknown>;
    const decoded = resolveSharedQuestionSources(wire, wire.sourceStates);
    const states = (decoded.questionSets ?? [decoded]) as Input[];
    const grouped = new Map<string, Input>();
    for (const input of states) {
      const current = grouped.get(input.document.id);
      if (current) current.labelCandidates.push(...input.labelCandidates);
      else grouped.set(input.document.id, structuredClone(input));
    }
    inputs.push(...grouped.values());
    const actual = resolveSharedQuestionTexts(questions, wire.questionTexts);
    return Object.fromEntries(Object.entries(actual).map(([id, question]) => {
      const indexed = /^(\d+)__(.+)$/.exec(id);
      return [id, answer(indexed?.[2] ?? id, question, indexed ? states[Number(indexed[1])] : states[0])];
    }));
  };
  const runtime = new JevRuntime(store, { startTimer: false }); opened.push({ root, runtime });
  await runtime.idle(); runtime.useTransport({ apiKey: 'native-label-key', decider });
  return { root, store, workspace, canvas: document, files, state, runtime, inputs };
}

describe('twelve saved native sources', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(Array.from({ length: 12 }, (_, index) => `Document topic ${index + 1}`)); });
it('automatically saves source-backed labels for all twelve native documents beyond the first eight vocabulary terms', async () => {
  const before = f.canvas.blocks.map(block => block.contentHash);
  const job = await f.runtime.run(f.workspace.id, { action: 'label', canvasId: f.canvas.id, blockIds: f.canvas.blocks.map(block => block.id) }, automationPrincipal);
  await f.runtime.idle();
  const state = await f.runtime.read(f.workspace.id);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', proposalIds: expect.any(Array) });
  expect(state.receipts).toHaveLength(12); expect(state.receipts.every(receipt => receipt.automatic && receipt.state === 'applied')).toBe(true);
  expect(f.inputs).toHaveLength(12);
  expect(f.inputs.every(input => input.labelCandidates.length === 8 && input.labelCandidates[0].name === input.document.title)).toBe(true);
  const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  expect(saved.blocks.map(block => block.tags)).toEqual(saved.blocks.map(block => [block.title]));
  expect(saved.blocks.map(block => block.contentHash)).toEqual(before);
});
});

it('keeps current labels first, then exact source membership and readable name relevance over unrelated global candidates', async () => {
  const f = await fixture(['Architecture'], { tags: ['Current correction'], content: '<html><head><style>Hidden finance topic</style></head><body><h1>Architecture</h1><p>Architecture uses deployment workflows.</p></body></html>' });
  const source = f.canvas.blocks[0];
  const term = (name: string, members: JevVocabularyTerm['members'] = []): JevVocabularyTerm => ({ id: name.replaceAll(' ', '-'), name, kind: 'label', definition: `Definition for ${name}.`, aliases: [], state: 'active', version: 1, members });
  f.state.vocabulary = [...Array.from({ length: 12 }, (_, index) => term(`Unrelated ${index}`)), term('Hidden finance topic'),
    term('Deployment workflows'), term('Architecture'), term('Current correction'),
    term('Source classification', [{ canvasId: f.canvas.id, blockId: source.id }]),
    term('Foreign classification', [{ canvasId: 'other-canvas', blockId: source.id }]),
    { ...term('Retired classification'), state: 'retired' }, { ...term('Entity classification'), kind: 'entity' }];
  // The foreign term has the same block id in another canvas; it must not gain source-member priority.
  await f.files.write(f.workspace.id, f.state);
  await f.runtime.run(f.workspace.id, { action: 'label', canvasId: f.canvas.id, blockIds: [source.id] }, automationPrincipal); await f.runtime.idle();
  expect(f.inputs[0].labelCandidates.slice(0, 4).map(candidate => candidate.name)).toEqual(['Current correction', 'Source classification', 'Architecture', 'Deployment workflows']);
  expect(f.inputs[0].labelCandidates[0].definition).toBe('Definition for Current correction.');
  expect(f.inputs[0].labelCandidates).toHaveLength(8);
  expect(f.inputs[0].labelCandidates.some(candidate => /Retired|Entity|Foreign|Hidden/.test(candidate.name))).toBe(false);
  expect((await new CanvasStore(f.root).getCanvas(f.canvas.id, true)).blocks[0].tags).toEqual(['Current correction']);
  expect((await f.runtime.read(f.workspace.id)).proposals[0].automaticHoldReason).toMatch(/manual/);
});

it('retains manual removed-label corrections even when that source label becomes the highest-priority candidate', async () => {
  const f = await fixture(['Removed source label']); const source = f.canvas.blocks[0];
  await f.store.jevExecutor.setOwnership(f.canvas.id, source.id, { removedLabels: ['Removed source label'] });
  await f.runtime.run(f.workspace.id, { action: 'label', canvasId: f.canvas.id, blockIds: [source.id] }, automationPrincipal); await f.runtime.idle();
  const saved = await new CanvasStore(f.root).getCanvas(f.canvas.id, true);
  expect(saved.blocks[0].tags ?? []).not.toContain('Removed source label');
  expect((await f.runtime.read(f.workspace.id)).proposals.some(proposal => proposal.automaticHoldReason?.includes('removed label correction'))).toBe(true);
});


it('keeps the saved semantic definition and membership when validated logical topics duplicate a source heading label', async () => {
  const f = await fixture(['Architecture']); const source = f.canvas.blocks[0];
  const snapshot = sourceSnapshot(f.workspace.id, f.canvas.id, source);
  const definition = 'Architecture describes checked service boundaries and their contracts.';
  f.state.vocabulary[0].definition = definition;
  f.state.profiles[`${f.canvas.id}:${source.id}`] = { source: { ...snapshot }, questionVersion: JEV_QUESTION_VERSION,
    logicalIndex: { version: 1, topics: [{ name: source.title, confidence: .99,
      evidence: [{ source: { ...snapshot }, start: 0, end: 14, quote: '# Architecture' }] }] } };
  await f.files.write(f.workspace.id, f.state);
  await f.runtime.run(f.workspace.id, { action: 'label', canvasId: f.canvas.id, blockIds: [source.id] }, automationPrincipal);
  await f.runtime.idle();
  expect(f.inputs[0].labelCandidates.filter(candidate => candidate.name === source.title)).toEqual([{ name: source.title, definition }]);
  expect((await new CanvasStore(f.root).getCanvasBlock(f.canvas.id, source.id)).tags).toEqual([source.title]);
  expect((await f.runtime.read(f.workspace.id)).vocabulary[0].definition).toBe(definition);
});
