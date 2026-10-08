import { automaticVocabulary } from './automatic.js';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation, type JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { CanvasStore } from '../../storage.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { automationPrincipal } from '../authorization.js';
import { evaluationContext } from '../context.js';
import { JevProposalExecutor } from '../proposals.js';
import { JevWorkspaceFiles } from '../workspace.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { QuestionAnswerCache } from './question-answer-cache.js';

type State = Record<string, unknown>;
type ProviderBody = { state: State & { questionSets?: State[] }; questions: Record<string, JevQuestion> };
let server: Server;
let origin: string;
let requests: ProviderBody[] = [];
let failAt = 0;
let holdAt = 0;
let choiceConfidence = 0.96;
let fitConfidence = 0.91;
let selectNone = false;
let fits: Record<string, number> = {};
let synonymies: Record<string, number> = {};
let requestReceived: (() => void) | undefined;
const held = new Set<ServerResponse>();

function answer(id: string, question: JevQuestion, body: ProviderBody): JevAnswer {
  const batch = /^(\d+)__(.+)$/.exec(id);
  const state = batch ? body.state.questionSets![Number(batch[1])] : body.state;
  if (question.type === 'noul') {
    if ((batch?.[2] ?? id) === 'synonymous') return { type: 'noul', noul: synonymies[`${state.sourceName}->${state.targetName}`] ?? 0.1 };
    const concept = (state.selectedConcept ?? state.concept) as { name: string } | undefined;
    return { type: 'noul', noul: fits[concept?.name ?? ''] ?? fitConfidence };
  }
  if (question.type !== 'choice') throw new Error('Unexpected vocabulary score question');
  const keys = Object.keys(question.criteria);
  let selected = selectNone ? 'none' : state.kind === 'entity' ? keys.find(key => question.criteria[key] === 'Alice') ?? 'none' : keys[0];
  if ((batch?.[2] ?? id) === 'parentEvidence') selected = keys.find(key => key.endsWith('p2')) ?? keys[0];
  return { type: 'choice', choice: selected, confidence: choiceConfidence,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as ProviderBody;
    requests.push(body); requestReceived?.();
    if (requests.length === holdAt) { held.add(response); return; }
    response.writeHead(requests.length === failAt ? 503 : 200, { 'Content-Type': 'application/json' });
    if (requests.length === failAt) { response.end(JSON.stringify({ detail: 'Temporary provider outage' })); return; }
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions)
      .map(([id, question]) => [id, answer(id, question, body)])) }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native automatic vocabulary provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterEach(() => { for (const response of held) response.destroy(); held.clear(); });
beforeEach(() => { requests = []; failAt = 0; holdAt = 0; choiceConfidence = 0.96; fitConfidence = 0.91;
  requestReceived = undefined; selectNone = false; fits = {}; synonymies = {}; });

function document(id: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id, title: 'Atlas', file: `${id}.md`, content: '# Atlas\nOwner: Alice\nAtlas defines release requirements and source history.',
    kind: 'markdown', x: 10, y: 20, width: 400, height: 300, links: [], tags: ['Atlas'] },
  snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id, incarnation: `inc_${id}`,
    sourceGeneration: 3, metadataRevision: 2, contentHash: `hash_${id}` } };
}
function context(documents = [document('one')]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Atlas' }], tasks: [], vocabulary: [],
    apiKey: 'local-fixture', settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] },
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
}
function request(blockIds = ['one']): JevActionRequest { return { action: 'vocab_lifecycle', canvasId: 'canvas', blockIds }; }
function states(body: ProviderBody): State[] { return body.state.questionSets ?? [body.state]; }
function term(name: string, kind: JevVocabularyTerm['kind']): JevVocabularyTerm {
  return { id: `${kind}-${name}`, kind, name, definition: 'Atlas release requirements.', aliases: [], state: 'candidate',
    version: 1, members: [{ canvasId: 'canvas', blockId: 'one' }] };
}

describe('native automatic vocabulary waves', () => {
  it('checks source-grounded selection and every candidate fit in one SDK wave without changing evidence, confidence or kind order', async () => {
    const input = context(); const before = structuredClone({ documents: input.documents, vocabulary: input.vocabulary });
    const result = await automaticVocabulary(input, request());
    expect(requests).toHaveLength(1);
    expect(requests.map(body => Object.keys(body.questions))).toEqual([
      ['0__concept', '1__fit', '2__concept', '3__fit', '4__fit', '5__concept', '6__fit'],
    ]);
    expect(states(requests[0]).filter(state => 'kind' in state).map(state => state.kind)).toEqual(['label', 'entity', 'group']);
    expect(states(requests[0]).filter(state => 'selectedConcept' in state).map(state => state.selectedConcept)).toEqual([
      expect.objectContaining({ kind: 'label', name: 'Atlas' }), expect.objectContaining({ kind: 'entity', name: 'Alice' }),
      expect.objectContaining({ kind: 'entity', name: 'Atlas' }), expect.objectContaining({ kind: 'group', name: 'Atlas' }),
    ]);
    expect(result.proposals.map(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.kind))
      .toEqual(['label', 'entity', 'group']);
    expect(result.proposals.map(proposal => proposal.decisionConfidences)).toEqual([
      [0.96, 0.91], [0.96, 0.91], [0.96, 0.91],
    ]);
    expect(result.result.discoveries).toMatchObject([
      { kind: 'label', status: 'proposed' }, { kind: 'entity', status: 'proposed' }, { kind: 'group', status: 'proposed' },
    ]);
    for (const proposal of result.proposals) {
      expect(proposal.sources).toEqual([input.documents[0].snapshot]);
      for (const evidence of proposal.evidence) {
        expect(evidence.source).toEqual(input.documents[0].snapshot);
        expect(input.documents[0].block.content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
      }
    }
    expect({ documents: input.documents, vocabulary: input.vocabulary }).toEqual(before);
  });

  it.each([0.65, 0.85])('retains the %s action threshold across batched selection and exact candidate fits', async threshold => {
    const input = context(); input.confidenceThreshold = threshold;
    fitConfidence = 0.75;
    const result = await automaticVocabulary(input, request());
    expect(requests).toHaveLength(1);
    expect(result.proposals).toHaveLength(threshold < fitConfidence ? 3 : 0);
    expect(result.result.discoveries).toMatchObject(['label', 'entity', 'group'].map(kind => ({
      kind, checkedConfidence: 0.75, status: threshold < fitConfidence ? 'proposed' : 'insufficient_concept_evidence',
    })));
  });

  it('keeps an uncertain selection from proposing a checked candidate and preserves exact single-kind question states', async () => {
    const input = context(); input.confidenceThreshold = 0.85; choiceConfidence = 0.8;
    expect((await automaticVocabulary(input, request())).proposals).toEqual([]);
    expect(requests).toHaveLength(1);
    requests = []; choiceConfidence = 0.96;
    const result = await automaticVocabulary(input, { ...request(), options: { kind: 'label' } });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(['0__concept', '1__fit']);
    expect(states(requests[0])).toMatchObject([{ kind: 'label' }, { selectedConcept: { kind: 'label', name: 'Atlas' } }]);
    expect(result.proposals).toHaveLength(1);
  });

  it('never substitutes a strongly supported unselected candidate for the unsupported selected concept', async () => {
    const input = context(); input.documents[0].block.tags = ['Atlas', 'Rollback'];
    input.documents[0].block.content += '\nRollback retains an earlier checked release.';
    fits = { Atlas: .2, Rollback: .99 };
    const result = await automaticVocabulary(input, { ...request(), options: { kind: 'label' } });
    expect(requests).toHaveLength(1); expect(Object.keys(requests[0].questions)).toEqual(['0__concept', '1__fit', '2__fit']);
    expect(states(requests[0]).slice(1).map(state => state.selectedConcept)).toEqual([
      expect.objectContaining({ name: 'Atlas', kind: 'label' }), expect.objectContaining({ name: 'Rollback', kind: 'label' }),
    ]);
    expect(result.proposals).toEqual([]);
    expect(result.result.discoveries).toMatchObject([{ choice: 'c0', selectedName: 'Atlas', checkedConfidence: .2,
      status: 'insufficient_concept_evidence' }]);
    expect(input.vocabulary).toEqual([]); expect(input.documents[0].block.tags).toEqual(['Atlas', 'Rollback']);
  });

  it('abstains on none even when every candidate fit is high, without defining or promoting an alternative', async () => {
    const input = context(); selectNone = true; fitConfidence = .99;
    const result = await automaticVocabulary(input, request());
    expect(requests).toHaveLength(1); expect(Object.keys(requests[0].questions).filter(id => id.endsWith('__fit'))).toHaveLength(4);
    expect(result.proposals).toEqual([]); expect(input.vocabulary).toEqual([]);
    expect(result.result.discoveries).toMatchObject(['label', 'entity', 'group'].map(kind => ({ kind, choice: 'none',
      checkedConfidence: null, status: 'insufficient_concept_evidence' })));
  });

  it('still checks selected group parent containment with its exact source passage after the independent fit wave', async () => {
    const input = context(); input.documents[0].block.content = '# Atlas\nOwner: Alice\nAtlas is the release requirements subgroup within Platform.';
    input.vocabulary = [{ ...term('Platform', 'group'), state: 'active', groupKey: 'custom:platform',
      definition: 'Platform includes the Atlas release requirements subgroup.' }];
    const result = await automaticVocabulary(input, { ...request(), options: { kind: 'group' } });
    expect(requests).toHaveLength(3);
    expect(Object.keys(requests[0].questions)).toEqual(['0__concept', '1__fit']);
    expect(requests[1].questions['0__parent'].instructions).toContain('proper subgroup');
    expect(states(requests[1])[1].selectedParent).toMatchObject({ id: 'group-Platform', groupKey: 'custom:platform' });
    expect(requests[1].questions['1__containment'].instructions).toContain('substantive containment');
    expect(requests[1].questions['1__parentEvidence'].type).toBe('choice');
    if (requests[1].questions['1__parentEvidence'].type === 'choice') expect(requests[1].questions['1__parentEvidence'].criteria.d0p2)
      .toBe('Atlas is the release requirements subgroup within Platform.');
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', term: {
      name: 'Atlas', parentId: 'group-Platform', groupKey: 'custom:platform/atlas',
    } });
    expect(result.proposals[0].decisionConfidences).toEqual([.96, .91]);
    expect(result.proposals).toHaveLength(1); expect(requests[2].questions.synonymous.instructions).toContain('same intended meaning and boundaries');
    expect(input.vocabulary).toHaveLength(1);
  });

  it('publishes the checked label result before a held native group hierarchy finishes, without applying any discovery', async () => {
    const input = context(); input.documents[0].block.content = '# Atlas\nOwner: Alice\nAtlas is the release requirements subgroup within Platform.';
    input.vocabulary = [{ ...term('Platform', 'group'), state: 'active', groupKey: 'custom:platform',
      definition: 'Platform includes the Atlas release requirements subgroup.' }];
    const before = structuredClone({ documents: input.documents, vocabulary: input.vocabulary });
    const notices: JevEvaluation[] = []; input.prefetchLabelDefinitions = result => { notices.push(result); };
    holdAt = 2;
    const hierarchyStarted = new Promise<void>(resolve => { requestReceived = () => { if (requests.length === holdAt) resolve(); }; });
    let settled = false;
    const pending = automaticVocabulary(input, request());
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await hierarchyStarted;
      expect(requests[1].questions['0__parent'].instructions).toContain('proper subgroup');
      expect(settled).toBe(false); expect(notices).toHaveLength(1);
      expect(notices[0].result.discovery).toMatchObject({ kind: 'label', selectedName: 'Atlas', status: 'proposed', checkedConfidence: .91 });
      expect(notices[0].proposals).toHaveLength(1);
      expect(notices[0].proposals[0]).toMatchObject({ mutation: { kind: 'vocabulary', term: { kind: 'label', name: 'Atlas', state: 'active' } },
        sources: [input.documents[0].snapshot], decisionConfidences: [.96, .91] });
      for (const passage of notices[0].proposals[0].evidence) {
        expect(passage.source).toEqual(input.documents[0].snapshot);
        expect(input.documents[0].block.content.slice(passage.start, passage.end)).toBe(passage.quote);
      }
      expect({ documents: input.documents, vocabulary: input.vocabulary }).toEqual(before);
    } finally {
      for (const response of held) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(requests[1].questions)
          .map(([id, question]) => [id, answer(id, question, requests[1])])) }));
      }
      held.clear();
    }
    const result = await pending;
    expect(result.proposals[0]).toBe(notices[0].proposals[0]);
    expect(result.proposals.map(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.term.kind)).toEqual(['label', 'entity', 'group']);
    expect({ documents: input.documents, vocabulary: input.vocabulary }).toEqual(before);
  });

  it('promotes checked existing candidates in one fit wave and does not duplicate discoveries for the next source', async () => {
    const input = context([document('one'), document('two')]);
    input.documents.forEach(document => { document.block.tags = []; });
    input.vocabulary = [term('Atlas', 'label'), term('Alice', 'entity'), term('Atlas', 'group'),
      { ...term('Atlas', 'entity'), state: 'active', definition: 'Archive account authentication.' }];
    const original = structuredClone(input.vocabulary);
    const result = await automaticVocabulary(input, request(['one', 'two']));
    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[1].questions)).toEqual(['synonymous']);
    expect(Object.keys(requests[0].questions)).toEqual(['0__concept', '1__fit', '2__concept', '3__fit', '4__concept', '5__fit']);
    expect(states(requests[0]).filter(state => 'concept' in state).map(state => state.concept)).toEqual(original.slice(0, 3));
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.every(proposal => proposal.mutation.kind === 'vocabulary'
      && proposal.mutation.operation === 'promote' && proposal.mutation.term.state === 'active')).toBe(true);
    expect(result.result.discoveries).toMatchObject([
      { blockId: 'one', kind: 'label' }, { blockId: 'one', kind: 'entity' }, { blockId: 'one', kind: 'group' },
      { blockId: 'two', kind: 'label', candidateCount: 0 }, { blockId: 'two', kind: 'entity', candidateCount: 0 },
      { blockId: 'two', kind: 'group', candidateCount: 0 },
    ]);
    expect(input.vocabulary).toEqual(original);
  });

  it('rejects every parallel discovery after a failed provider wave without returning partial proposals', async () => {
    const input = context(); failAt = 1;
    await expect(automaticVocabulary(input, request())).rejects.toMatchObject({ status: 502, message: 'Jev request failed (503): Temporary provider outage' });
    expect(requests).toHaveLength(1);
    expect(input.vocabulary).toEqual([]);
    expect(input.documents[0].block.tags).toEqual(['Atlas']);
  });

  it('cancels the in-flight candidate selection and fit wave through the actual SDK and settles every parallel discovery', async () => {
    const input = context(); const controller = new AbortController(); input.signal = controller.signal; holdAt = 1;
    const received = new Promise<void>(resolve => { requestReceived = () => { if (requests.length === 1) resolve(); }; });
    const pending = automaticVocabulary(input, request());
    const rejected = expect(pending).rejects.toMatchObject({ status: 499 });
    await received;
    controller.abort();
    await rejected;
    expect(requests).toHaveLength(1);
    expect(input.vocabulary).toEqual([]);
  });

  it('retains historical vocabulary evidence after reload but refuses removed automatic execution without changing source bytes or position', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jev-one-wave-native-'));
    try {
      const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
      const workspaceId = (await store.createWorkspace({ name: 'Native one-wave vocabulary' })).id;
      const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas release' })).id;
      const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\r\nRelease requirements cite exact source history.\r\n', x: 41, y: 73 });
      const bytes = await readFile(path.join(root, source.file));
      const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
      const scoped: JevActionRequest = { action: 'vocab_lifecycle', canvasId, blockIds: [source.id], options: { kind: 'label' } };
      const input = await evaluationContext(store, workspaceId, state, scoped, automationPrincipal, new AbortController().signal);
      input.apiKey = 'local-fixture'; input.decider = context().decider;
      const result = await automaticVocabulary(input, scoped);
      expect(requests).toHaveLength(1); expect(result.proposals).toHaveLength(1);
      const candidate = result.proposals[0];
      expect(candidate.decisionConfidences).toEqual([.96, .91]);
      expect(candidate.evidence.every(passage => source.content.slice(passage.start, passage.end) === passage.quote)).toBe(true);
      const proposal = { ...candidate, id: randomUUID(), jobId: 'native-checked-wave', state: 'pending' as const, createdAt: new Date().toISOString() };
      state.proposals.push(proposal); await files.write(workspaceId, state);
      await expect(files.serial(workspaceId, () => new JevProposalExecutor(store, files).applyInside(workspaceId, proposal.id, automationPrincipal, true)))
        .rejects.toMatchObject({ status: 409 });
      const restored = await new JevWorkspaceFiles(root).read(workspaceId);
      expect(restored.vocabulary).toEqual([]); expect(restored.receipts).toEqual([]);
      expect(restored.proposals.find(candidate => candidate.id === proposal.id)).toMatchObject({ state: 'dismissed', decisionConfidences: [.96, .91], evidence: candidate.evidence });
      expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, x: 41, y: 73 });
      expect(await readFile(path.join(root, source.file))).toEqual(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reuses the exact primary concept choice after checked automatic filing saves that group, without defining an alternative heading', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jev-stable-concept-native-'));
    try {
      const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
      const workspaceId = (await store.createWorkspace({ name: 'Native stable source concept' })).id;
      const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas release' })).id;
      const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas release requirements.\n## Rollback\nRetain the previous release until review.', x: 41, y: 73 });
      const bytes = await readFile(path.join(root, source.file)); const files = new JevWorkspaceFiles(root);
      const scoped: JevActionRequest = { action: 'vocab_lifecycle', canvasId, blockIds: [source.id] };
      const cache = new QuestionAnswerCache();
      const read = async () => {
        const input = await evaluationContext(store, workspaceId, await files.read(workspaceId), scoped, automationPrincipal, new AbortController().signal);
        input.apiKey = 'local-fixture'; input.decider = context().decider;
        return cachedQuestionContext(input, cache, 'native-source-primary-concepts');
      };
      const initial = await automaticVocabulary(await read(), scoped);
      expect(initial.proposals.filter(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.term.kind === 'group'))
        .toMatchObject([{ mutation: { term: { name: 'Atlas' } } }]);
      const filed = await evaluateJevAction(await read(), { ...scoped, action: 'file' });
      expect(filed.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ mutation: {
        kind: 'document', canvasId, blockId: source.id, patch: { group: 'custom:atlas' },
      } })]));
      for (const candidate of filed.proposals) {
        const state = await files.read(workspaceId);
        const proposal = { ...candidate, id: randomUUID(), jobId: 'native-checked-filing', state: 'pending' as const, createdAt: new Date().toISOString() };
        state.proposals.push(proposal); await files.write(workspaceId, state);
        await files.serial(workspaceId, () => new JevProposalExecutor(store, files).applyInside(workspaceId, proposal.id, automationPrincipal, true));
      }
      const before = requests.length; const after = await automaticVocabulary(await read(), scoped);
      expect(requests).toHaveLength(before);
      expect(after.proposals.filter(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.term.kind === 'group')).toEqual([]);
      expect(after.result.discoveries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'group',
        selectedName: 'Atlas', status: 'existing_concept', proposalCount: 0 })]));
      const restored = await new JevWorkspaceFiles(root).read(workspaceId);
      expect(restored.vocabulary.filter(term => term.kind === 'group')).toMatchObject([{ name: 'Atlas', state: 'active', groupKey: 'custom:atlas' }]);
      expect(restored.vocabulary.some(term => term.name === 'Rollback')).toBe(false);
      expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toMatchObject({ content: source.content, group: 'custom:atlas', x: 41, y: 73 });
      expect(await readFile(path.join(root, source.file))).toEqual(bytes);
      const current = await store.updateBlock(canvasId, source.id, { title: 'Delivery',
        content: '# Delivery\nOwner: Alice\nDelivery release requirements.\n## Rollback\nRetain the previous release until review.' }, 'Browser');
      const revised = await automaticVocabulary(await read(), scoped);
      expect(requests.length).toBeGreaterThan(before);
      expect(revised.result.discoveries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'group', selectedName: 'Delivery' })]));
      expect(revised.proposals.every(candidate => candidate.sources.every(source => source.contentHash === current.contentHash))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejudges changed source names and manual removed-label corrections while already-known primary concepts remain untouched', async () => {
    const input = context(); input.documents[0].block.tags = ['Atlas', 'Rollback'];
    const cache = new QuestionAnswerCache(); const scoped = { ...request(), options: { kind: 'label' } };
    const read = () => cachedQuestionContext(input, cache, 'native-manual-source-corrections');
    await automaticVocabulary(read(), scoped); expect(requests).toHaveLength(1);
    input.vocabulary = [{ ...term('Atlas', 'label'), state: 'retired' }];
    let result = await automaticVocabulary(read(), scoped);
    expect(requests).toHaveLength(1); expect(result.proposals).toEqual([]);
    expect(result.result.discoveries).toMatchObject([{ status: 'existing_concept', selectedName: 'Atlas', proposalCount: 0 }]);
    input.documents[0].block.jevOwnership = { managed: ['tags'], pins: [], removedLabels: ['Atlas'], removedLinks: [] };
    result = await automaticVocabulary(read(), scoped);
    expect(requests).toHaveLength(2); expect(result.result.discoveries).toMatchObject([{ selectedName: 'Rollback' }]);
    expect(result.proposals.every(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.term.name === 'Rollback')).toBe(true);
    input.documents[0].block.title = 'New source'; input.documents[0].block.content = '# New source\nChanged purpose and responsibility.';
    await automaticVocabulary(read(), scoped); expect(requests).toHaveLength(3);
  });

  it('keeps a newly saved native-only active group out of the intrinsic concept choice universe', async () => {
    const input = context(); const cache = new QuestionAnswerCache(); const scoped = { ...request(), options: { kind: 'group' } };
    selectNone = true;
    const read = () => cachedQuestionContext(input, cache, 'native-only-known-category');
    expect((await automaticVocabulary(read(), scoped)).proposals).toEqual([]); expect(requests).toHaveLength(1);
    input.documents[0].block.group = 'custom:platform'; input.documents[0].snapshot.metadataRevision += 1;
    input.vocabulary = [{ ...term('Platform', 'group'), state: 'active', groupKey: 'custom:platform' }];
    input.canvases[0].groups = [{ id: 'custom:platform', name: 'Platform' }];
    const result = await automaticVocabulary(read(), scoped);
    expect(requests).toHaveLength(1); expect(result.proposals).toEqual([]);
    expect(result.result.discoveries).toMatchObject([{ choice: 'none', status: 'insufficient_concept_evidence' }]);
    expect(input.vocabulary[0]).toMatchObject({ name: 'Platform', state: 'active', groupKey: 'custom:platform' });
  });

  it.each([[.29, .28, .1, false], [.3, .6, .5, true], [.99, .31, .4, true]] as const)
  ('checks every exact synonym pair and takes one highest accepted merge at scores %s/%s/%s', async (first, second, third, merged) => {
    const input = context(); input.vocabulary = ['Atlas', 'Release policy', 'Shipping guidance'].map(name => ({ ...term(name, 'label'), state: 'active' }));
    const original = structuredClone(input.vocabulary);
    synonymies = { 'Release policy->Atlas': first, 'Shipping guidance->Atlas': second, 'Shipping guidance->Release policy': third };
    const result = await automaticVocabulary(input, { ...request(), options: { kind: 'label' } });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(['0__synonymous', '1__synonymous', '2__synonymous']);
    expect(states(requests[0])).toMatchObject([
      { sourceName: 'Release policy', targetName: 'Atlas', sourceConcept: original[1].definition, targetConcept: original[0].definition },
      { sourceName: 'Shipping guidance', targetName: 'Atlas' }, { sourceName: 'Shipping guidance', targetName: 'Release policy' },
    ]);
    expect(result.result.synonymySupported).toBe(merged); expect(input.vocabulary).toEqual(original);
    if (!merged) { expect(result.proposals).toEqual([]); return; }
    expect(result.proposals).toHaveLength(3);
    const selectedName = first > second ? 'Release policy' : 'Shipping guidance';
    expect(result.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', operation: 'merge', previousId: 'label-' + selectedName,
      term: { id: 'label-Atlas', aliases: [selectedName], version: 2 } });
    const expectedConfidence = calibrated(Math.max(first, second, third), decisionBoundaries.synonym);
    expect(result.proposals.every(candidate => JSON.stringify(candidate.decisionConfidences) === JSON.stringify([expectedConfidence]))).toBe(true);
    expect(result.proposals.filter(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.operation === 'merge')).toHaveLength(1);
    expect(result.proposals.every(candidate => candidate.evidence.every(passage => input.documents[0].block.content.slice(passage.start, passage.end) === passage.quote))).toBe(true);
  });
});
