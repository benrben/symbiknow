import { attachDocToTask, assignOwner, scoreQuality } from './work.js';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jevActions, type JevActionRequest, type JevEvaluation, type JevPrincipal } from '../../../shared/jev-types.js';
import type { CanvasBlock, CanvasTask } from '../../../shared/types.js';
import { decideWithJev, estimateJevTokens, type JevAnswer, type JevDecider, type JevQuestion } from '../../jev.js';
import { CanvasStore } from '../../storage.js';
import { JEV_QUESTION_VERSION, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { JevRuntime } from '../runtime.js';
import { emptyJevWorkspace } from '../workspace.js';

type SourceState = { id: string; title: string; passages: Array<{ id: string; text: string }> };
type WorkState = { source?: SourceState; document?: SourceState; task?: { title: string; detail: string; criteria?: unknown[] };
  selectedPerson?: { id: string; name: string; role: string }; assignment?: { field: string; responsibility: string };
  people?: Array<{ id: string; name: string; role: string }>; qualityLevels?: string[];
  assessments?: Record<string, { score: number; scale: string[] }>; declaredPurpose?: string | null; questionSets?: WorkState[] };
type ProviderBody = { model: string; state: WorkState; questions: Record<string, JevQuestion> };
type Decision = { choice?: string; score?: number; confidence?: number; noul?: number };
type Rule = (id: string, state: WorkState, question: JevQuestion) => Decision | undefined;
let provider: Server;
let origin: string;
let requests: ProviderBody[];
let rule: Rule;
let failureAt: number;
let holdAt: number;
let invalidAt: number;
let received: (() => void) | undefined;
const heldResponses = new Set<ServerResponse>();
const runtimes: Array<{ runtime: JevRuntime; root: string }> = [];

function answer(id: string, question: JevQuestion, body: ProviderBody): JevAnswer {
  const batch = /^(\d+)__(.+)$/.exec(id);
  const state = batch ? body.state.questionSets![Number(batch[1])] : body.state;
  const name = batch ? batch[2] : id;
  const decision = rule(name, state, question) ?? {};
  if (question.type === 'noul') return { type: 'noul', noul: decision.noul ?? (['addressesAi', 'synonymous', 'conflict'].includes(name) ? 0.01 : 0.98) };
  if (question.type === 'score') {
    const score = decision.score ?? question.criteria.length - 1;
    return { type: 'score', score, confidence: decision.confidence ?? 0.98,
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === Math.floor(score) ? 1 : 0])) };
  }
  const keys = Object.keys(question.criteria);
  const choice = decision.choice ?? (['parent', 'pair', 'canvas'].includes(name) ? 'none' : keys[0]);
  return { type: 'choice', choice, confidence: decision.confidence ?? 0.98,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) };
}
beforeEach(async () => {
  requests = []; rule = () => undefined; failureAt = 0; holdAt = 0; invalidAt = 0; received = undefined; vi.stubEnv('TYPESAFE_API_KEY', '');
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as ProviderBody; requests.push(body);
    if (requests.length === holdAt) { heldResponses.add(response); received?.(); return; }
    response.writeHead(requests.length === failureAt ? 503 : 200, { 'content-type': 'application/json' });
    if (requests.length === failureAt) { response.end(JSON.stringify({ detail: 'Native work provider unavailable' })); return; }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(id, question, body)]));
    if (requests.length === invalidAt) delete answers[Object.keys(answers)[0]];
    response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native work provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  for (const response of heldResponses) response.destroy(); heldResponses.clear();
  for (const { runtime, root } of runtimes.splice(0)) { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  vi.unstubAllEnvs();
});

const nativeDecider: JevDecider = (key, state, questions, _fetcher, options) =>
  decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options);
function document(id: string, canvasId = 'canvas', patch: Partial<CanvasBlock> = {}): JevInputDocument {
  return { canvasId, snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: `inc_${id}`,
    sourceGeneration: 4, metadataRevision: 3, contentHash: `hash_${id}` },
  block: { id, title: `Atlas ${id}`, file: `${id}.md`, kind: 'markdown', content: `Atlas ${id} release requirements.\n\nMaya owns Atlas ${id}; Ben reviews the release.`,
    x: 32, y: 64, width: 400, height: 300, links: [], ...patch } };
}
function task(id: string, patch: Partial<CanvasTask> = {}): CanvasTask {
  return { id, title: `Release ${id}`, detail: `Deliver the Atlas ${id} release.`, status: 'todo', blockIds: ['existing-source'],
    revision: 7, acceptanceCriteria: [{ id: 'reviewed', text: 'The release checklist is reviewed.' }],
    createdBy: 'Browser', updatedBy: 'Browser', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', comments: [], ...patch };
}
function context(documents = [document('one'), document('two')], tasks = [task('alpha'), task('beta')]): JevEvaluationContext {
  const settings = emptyJevWorkspace().settings;
  settings.people = [{ id: 'maya', name: 'Maya', role: 'Release owner' }, { id: 'ben', name: 'Ben', role: 'Reviewer' }];
  return { workspaceId: 'workspace', documents, tasks: tasks.map(task => ({ canvasId: 'canvas', task })),
    canvases: [{ id: 'canvas', name: 'Atlas' }], vocabulary: [], settings, apiKey: 'native-work-fixture', decider: nativeDecider };
}
function request(action: JevActionRequest['action'], blockIds?: string[]): JevActionRequest { return { action, canvasId: 'canvas', ...(blockIds ? { blockIds } : {}) }; }
function states(body: ProviderBody): WorkState[] { return body.state.questionSets ?? [body.state]; }
function pairIds(bodies = requests): string[] { return bodies.flatMap(states).map(state => `${(state.source ?? state.document)!.id}->${state.task!.title}`); }
function taskPatch(candidate: JevEvaluation['proposals'][number]) {
  if (candidate.mutation.kind !== 'task_update') throw new Error('Expected a checked native task mutation');
  return candidate.mutation;
}
function exactQuotes(result: JevEvaluation, documents: JevInputDocument[]) {
  for (const candidate of result.proposals) for (const passage of candidate.evidence) {
    const source = documents.find(document => document.block.id === passage.source.blockId)!;
    expect(passage.source).toEqual(source.snapshot);
    expect(source.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  }
}
function largeContext() {
  return context(['one', 'two', 'three', 'four'].map(id => document(id, 'canvas', { content: Array.from({ length: 8 }, (_, index) =>
    `Atlas ${id} release paragraph ${index}. ${'Review the exact release requirement. '.repeat(14)}`).join('\n\n') })));
}
const workActions = ['attach_doc_to_task', 'assign_owner', 'score_quality'] as const;
function boundedInterruptedWave(action: typeof workActions[number]) {
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.length).toBeLessThanOrEqual(4);
  if (action === 'attach_doc_to_task') return;
  expect(requests.flatMap(states).every(state => !state.selectedPerson && !state.assessments)).toBe(true);
  const field = action === 'assign_owner' ? 'people' : 'qualityLevels';
  expect(requests.flatMap(states).every(state => state[field])).toBe(true);
}

describe('native work decision batching', () => {
  it('judges independent task attachments once and preserves source order, existing attachments, exact evidence and task revisions', async () => {
    const input = context(); const original = structuredClone({ documents: input.documents, tasks: input.tasks });
    input.tasks[0].task.blockIds.push('one'); original.tasks[0].task.blockIds.push('one');
    rule = (id, state) => id === 'evidence' ? { choice: 'p1', confidence: 0.2 }
      : id === 'matches' ? { noul: state.document!.id === 'one' ? 0.91 : 0.97 } : undefined;
    const result = await evaluateWorkHelper(input, request('attach_doc_to_task'));
    expect(requests).toHaveLength(1); expect(pairIds()).toEqual(['one->Release beta', 'two->Release alpha', 'two->Release beta']);
    expect(result.result.proposalCount).toBe(3);
    expect(result.proposals.map(candidate => taskPatch(candidate))).toEqual([
      { kind: 'task_update', canvasId: 'canvas', taskId: 'beta', expectedUpdatedAt: input.tasks[1].task.updatedAt, expectedRevision: 7, patch: { blockIds: ['existing-source', 'one'] } },
      { kind: 'task_update', canvasId: 'canvas', taskId: 'alpha', expectedUpdatedAt: input.tasks[0].task.updatedAt, expectedRevision: 7, patch: { blockIds: ['existing-source', 'one', 'two'] } },
      { kind: 'task_update', canvasId: 'canvas', taskId: 'beta', expectedUpdatedAt: input.tasks[1].task.updatedAt, expectedRevision: 7, patch: { blockIds: ['existing-source', 'two'] } },
    ]);
    expect(result.proposals.map(candidate => candidate.confidence)).toEqual([0.91, 0.97, 0.97]);
    expect(result.proposals.map(candidate => candidate.evidence[0].quote)).toEqual([
      'Maya owns Atlas one; Ben reviews the release.', 'Maya owns Atlas two; Ben reviews the release.', 'Maya owns Atlas two; Ben reviews the release.']);
    for (const [id, question] of Object.entries(requests[0].questions)) expect(question.instructions).toContain(`Use only questionSets[${id.split('__')[0]}]`);
    expect({ documents: input.documents, tasks: input.tasks }).toEqual(original); exactQuotes(result, input.documents);
  });

  it('keeps unsupported attachments and missing evidence isolated while excluding unselected sources and foreign tasks', async () => {
    const input = context([document('one'), document('two'), document('unselected'), document('remote', 'other')]);
    input.tasks.push({ canvasId: 'other', task: task('foreign') });
    input.confidenceThreshold = 0.85;
    rule = (id, state) => id === 'matches' && state.document!.id === 'two' ? { noul: 0.75 }
      : id === 'evidence' && state.task!.title === 'Release beta' ? { choice: 'none' } : undefined;
    const result = await evaluateWorkHelper(input, request('attach_doc_to_task', ['one', 'two']));
    expect(pairIds()).toEqual(['one->Release alpha', 'one->Release beta', 'two->Release alpha', 'two->Release beta']);
    expect(result.proposals.map(candidate => taskPatch(candidate).taskId)).toEqual(['alpha']);
    expect(result.proposals[0].sources).toEqual([input.documents[0].snapshot]);
    expect(JSON.stringify(requests)).not.toContain('unselected'); expect(JSON.stringify(requests)).not.toContain('foreign');
  });

  it('selects owners and their individually bound evidence in one wave with stable task/source proposal order', async () => {
    const input = context([document('one'), document('two'), document('unknown')]);
    rule = (id, state) => id === 'person' ? { choice: state.source!.id === 'unknown' ? 'none' : state.source!.id === 'two' ? 'person1' : 'person0', confidence: state.source!.id === 'one' ? 0.92 : 0.96 }
      : id.startsWith('evidence_') ? { choice: state.task!.title === 'Release beta' && state.source!.id === 'two' ? 'unknown' : 'p1', confidence: 0.1 } : undefined;
    const result = await evaluateWorkHelper(input, request('assign_owner'));
    expect(requests).toHaveLength(1);
    expect(pairIds([requests[0]])).toEqual(['one->Release alpha', 'two->Release alpha', 'unknown->Release alpha', 'one->Release beta', 'two->Release beta', 'unknown->Release beta']);
    expect(states(requests[0]).every(state => JSON.stringify(state.people) === JSON.stringify(input.settings.people)
      && state.assignment?.field === 'assignee' && state.assignment.responsibility === 'ownership')).toBe(true);
    for (const [id, question] of Object.entries(requests[0].questions).filter(([id]) => /evidence_\d+$/.test(id))) {
      expect(question.instructions).toContain(`people[${id.slice(-1)}]`);
    }
    expect(result.proposals.map(candidate => [taskPatch(candidate).taskId, candidate.sources[0].blockId, taskPatch(candidate).patch, candidate.confidence])).toEqual([
      ['alpha', 'one', { assignee: 'maya' }, 0.92], ['alpha', 'two', { assignee: 'ben' }, 0.96], ['beta', 'one', { assignee: 'maya' }, 0.92]]);
    exactQuotes(result, input.documents);
  });

  it('ignores precomputed evidence for unsupported person choices and retains explicit reviewer selection for a single pair', async () => {
    const input = context([document('one')], [task('alpha', { acceptanceCriteria: undefined })]);
    input.confidenceThreshold = 0.85;
    rule = id => id === 'person' ? { choice: 'person0', confidence: 0.75 } : { choice: 'p1' };
    expect((await evaluateWorkHelper(input, request('assign_owner'))).proposals).toEqual([]); expect(requests).toHaveLength(1);
    requests = []; rule = id => id === 'person' ? { choice: 'person1' } : { choice: 'p1' };
    const reviewer = await evaluateWorkHelper(input, { ...request('assign_owner'), options: { subaction: 'assign_reviewer', taskId: 'alpha' } });
    expect(requests).toHaveLength(1); expect(requests[0].state.questionSets).toBeUndefined();
    expect(Object.keys(requests[0].questions)).toEqual(['person', 'evidence_0', 'evidence_1']);
    expect(requests[0].questions.person.instructions).toContain('reviewing this task');
    expect(requests[0].state).toMatchObject({ people: input.settings.people, task: { criteria: [] }, assignment: { field: 'reviewer', responsibility: 'review responsibility' } });
    expect(requests[0].questions.evidence_1.instructions).toContain('people[1]');
    expect(taskPatch(reviewer.proposals[0]).patch).toEqual({ reviewer: 'ben' });
  });

  it('batches source-specific quality scores and validates evidence against those exact scores without mixing advisory rubrics', async () => {
    const input = context([document('one'), document('two', 'canvas', { purpose: 'Record the release decision.' })]);
    input.confidenceThreshold = 0.85;
    rule = (id, state, question) => question.type === 'score' ? { score: state.source!.id === 'one' ? 1 : 2.5, confidence: state.source!.id === 'one' ? 0.75 : 0.96 }
      : id === 'traceabilityEvidence' && state.source!.id === 'two' ? { choice: 'none' } : { choice: 'p1', confidence: 0.1 };
    const result = await evaluateWorkHelper(input, request('score_quality'));
    expect(requests).toHaveLength(2); expect(states(requests[0]).map(state => state.source!.id)).toEqual(['one', 'two']);
    expect(states(requests[0]).map(state => state.declaredPurpose)).toEqual([null, 'Record the release decision.']);
    expect(states(requests[0]).every(state => !state.assessments)).toBe(true);
    expect(states(requests[1]).map(state => state.source!.id)).toEqual(['two']);
    expect(states(requests[1]).map(state => state.assessments!.specificity)).toEqual([
      { score: 2.5, scale: ['Insufficient evidence', 'Substantial gaps', 'Partly supported', 'Well supported'] }]);
    expect(result.result.documents).toMatchObject({ one: { advisory: true, rubric: { specificity: { score: 1, confidence: 0.75, status: 'uncertain' } } },
      two: { advisory: true, rubric: { specificity: { score: 2.5, confidence: 0.96 }, traceability: { status: 'insufficient_evidence' } } } });
    expect(result.proposals.map(candidate => candidate.sources[0].blockId)).toEqual(['one', 'two']); exactQuotes(result, input.documents);
  });

  it('keeps absent source/task/person decisions local and preserves a single attachment and quality request format', async () => {
    for (const action of workActions) expect((await evaluateWorkHelper(context([]), request(action))).proposals).toEqual([]);
    for (const action of ['assign_owner', 'attach_doc_to_task'] as const) expect((await evaluateWorkHelper(context(undefined, []), request(action))).proposals).toEqual([]);
    const unknown = context(); unknown.settings.people = [];
    expect((await evaluateWorkHelper(unknown, request('assign_owner'))).result).toEqual({ status: 'no_known_people' }); expect(requests).toEqual([]);
    const input = context([document('one')], [task('alpha')]);
    await evaluateWorkHelper(input, { ...request('attach_doc_to_task'), options: { taskId: 'alpha' } });
    expect(requests).toHaveLength(1); expect(requests[0].state.questionSets).toBeUndefined();
    expect(Object.keys(requests[0].questions)).toEqual(['matches', 'evidence']);
    expect(requests[0].state).toMatchObject({ document: { id: 'one' }, task: { title: 'Release alpha', criteria: input.tasks[0].task.acceptanceCriteria },
      decisionProgram: { questionVersion: JEV_QUESTION_VERSION, sourceTrust: 'untrusted_evidence' } });
    requests = []; await evaluateWorkHelper(input, request('score_quality'));
    expect(requests).toHaveLength(1); expect(requests[0].state.questionSets).toBeUndefined();
    expect(Object.keys(requests[0].questions)).toEqual(['specificity', 'traceability', 'declaredPurposeCompleteness', 'internalConsistency']
      .flatMap(dimension => [dimension, ...[0, 1, 2, 3].map(level => `${dimension}Evidence_${level}`)]));
    requests = []; await expect(evaluateWorkHelper(input, { ...request('attach_doc_to_task'), options: { taskId: 'missing' } })).rejects.toMatchObject({ status: 404 }); expect(requests).toEqual([]);
  });

  it.each(workActions)('bounds large independent %s question sets without reverting to one request per pair', async action => {
    const input = largeContext(); const result = await evaluateWorkHelper(input, request(action));
    const serialRequests = action === 'score_quality' ? 8 : action === 'assign_owner' ? 16 : 8;
    expect(requests.length).toBeGreaterThan(1); expect(requests.length).toBeLessThan(serialRequests);
    expect(result.proposals).toHaveLength(action === 'score_quality' ? 4 : 8);
    for (const body of requests) expect(estimateJevTokens(body.state) + estimateJevTokens(body.questions)).toBeLessThanOrEqual(16000);
    exactQuotes(result, input.documents);
  });

  it.each(workActions)('rejects the entire %s evaluation after a later real provider failure without returning partial proposals', async action => {
    const input = largeContext(); const original = structuredClone({ documents: input.documents, tasks: input.tasks }); failureAt = 2;
    await expect(evaluateWorkHelper(input, request(action))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('(503)') });
    boundedInterruptedWave(action);
    expect({ documents: input.documents, tasks: input.tasks }).toEqual(original);
  });

  it.each(workActions)('propagates SDK cancellation during a later %s request without returning an earlier partial result', async action => {
    const input = largeContext(); const original = structuredClone({ documents: input.documents, tasks: input.tasks });
    const controller = new AbortController(); input.signal = controller.signal; holdAt = 2;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const pending = evaluateWorkHelper(input, request(action));
    const rejected = expect(pending).rejects.toMatchObject({ status: 499, message: 'Jev request was cancelled' });
    await arrived; controller.abort(); await rejected;
    boundedInterruptedWave(action);
    expect({ documents: input.documents, tasks: input.tasks }).toEqual(original);
  });

  it('rejects invalid combined answers before publishing any selected owner proposals', async () => {
    invalidAt = 1; await expect(evaluateWorkHelper(context(), request('assign_owner'))).rejects.toMatchObject({ status: 502 });
    expect(requests).toHaveLength(1);
  });
});

describe('automatic native task outcomes with batched work decisions', () => {
  let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string;
  let source: CanvasBlock; let tasks: CanvasTask[];
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jev-work-batch-')); store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    workspaceId = (await store.createWorkspace({ name: 'Automatic release work' })).id;
    canvasId = (await store.createCanvas(workspaceId, { name: 'Release guides' })).id;
    tasks = [await store.createTask(canvasId, { title: 'Atlas release', detail: 'Deliver Atlas release.' }, 'Browser'),
      await store.createTask(canvasId, { title: 'Atlas rollout', detail: 'Deliver Atlas rollout.' }, 'Browser')];
    source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nOwner: Maya\nMaya owns Atlas release and Atlas rollout. Follow the release checklist.' });
    rule = (id, state) => id.startsWith('evidence_') && state.assignment ? { choice: 'p1' } : undefined;
    runtime = new JevRuntime(store, { apiKey: 'native-work-batch-runtime', startTimer: false, fetcher: (_url, init) => fetch(origin, init) });
    runtimes.push({ runtime, root });
  });
  it('runs the six current actions without changing task attachments or ownership and reloads without duplicate work', async () => {
    const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
    await runtime.idle(); const state = await runtime.read(workspaceId, owner);
    expect(new Set(state.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
    expect(state.jobs.every(job => job.state === 'completed')).toBe(true); expect(state.proposals.filter(candidate => candidate.state === 'pending')).toEqual([]);
    const workRequests = requests.filter(body => states(body).some(state => state.task));
    expect(workRequests).toHaveLength(0);
    const reloaded = new CanvasStore(root); await reloaded.init(); const saved = await reloaded.listTasks(canvasId);
    expect(saved.map(task => task.id)).toEqual(tasks.map(task => task.id));
    expect(saved).toEqual(tasks);
    expect((await reloaded.getCanvasBlock(canvasId, source.id))).toMatchObject({ content: source.content, contentHash: source.contentHash, sourceGeneration: source.sourceGeneration });
    expect(state.profiles[`${canvasId}:${source.id}`]?.qualityRubric).toBeUndefined();
    expect(state.profiles[`${canvasId}:${source.id}`]?.recall).toBeUndefined();
    const calls = requests.length; await runtime.tick(); await runtime.idle(); expect(requests).toHaveLength(calls);
    expect((await runtime.read(workspaceId, owner)).jobs).toEqual(state.jobs);
  });
});

// Historical work algorithms remain unit-tested independently of the current public action registry.
function evaluateWorkHelper(context: JevEvaluationContext, request: JevActionRequest) {
  const helper = { attach_doc_to_task: attachDocToTask, assign_owner: assignOwner, score_quality: scoreQuality }[request.action as typeof workActions[number]];
  return helper(context, request);
}
