import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acceptanceReflexProvider } from '../../features/acceptance-reflex-provider.js';
import type { JevActionRequest, JevEvaluation } from '../../shared/jev-types.js';
import type { CanvasBlock } from '../../shared/types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import type { JevEvaluationContext } from './actions.js';
import { resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';
import { JevRuntime } from './runtime.js';
import type { StoredJevJob } from './runtime-queue.js';
import type { JevQueuedCandidate } from './runtime-scheduler.js';
import { JevWorkspaceFiles } from './workspace.js';

type Evaluation = { workspaceId: string; action: JevActionRequest['action']; blockIds: string[] };
type Call = Evaluation & { raw: string; response: ServerResponse };
type Outcome = { candidate: JevQueuedCandidate; failed: boolean; error?: unknown };
const scope = new AsyncLocalStorage<Evaluation>();
let root = ''; let provider: Server | undefined; let runtime: JevRuntime | undefined;
let calls: Call[] = []; let changed: (() => void) | undefined;
let store: CanvasStore; let workspaceId: string; let canvasId: string; let otherWorkspaceId: string;
let documents: CanvasBlock[];

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); calls = []; changed = undefined;
  provider = undefined; runtime = undefined;
  root = await mkdtemp(path.join(tmpdir(), 'jev-admission-drain-')); await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Large saved-source backlog' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas delivery' })).id;
  documents = await Promise.all(Array.from({ length: 5 }, (_, index) => store.createBlock(canvasId, {
    title: 'Atlas delivery guide', content: '# Platform\nAtlas delivery retains reviewed source history and release requirements.',
    tags: ['Human review'], x: 73 + index * 500, y: 91,
  }, 'Browser')));
  documents[0] = await store.updateBlock(canvasId, documents[0].id, { reviewer: 'Human reviewer' }, 'Browser');
  otherWorkspaceId = (await store.createWorkspace({ name: 'Independent workspace' })).id;
  const otherCanvasId = (await store.createCanvas(otherWorkspaceId, { name: 'Other delivery' })).id;
  await store.createBlock(otherCanvasId, { title: 'Other delivery', content: '# Other platform\nA separate delivery reference.' });
});

afterEach(async () => {
  await runtime?.shutdown();
  for (const call of calls) call.response.destroy();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider!.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>(resolve => { changed = resolve; });
  changed = undefined;
}
async function release(call: Call): Promise<void> {
  const response = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: call.raw });
  const result = await response.json() as { answers: Record<string, JevAnswer> };
  const request = JSON.parse(call.raw) as { state: { questionTexts?: string[] }; questions: Record<string, JevQuestion> };
  const questions = resolveSharedQuestionTexts(request.questions, request.state.questionTexts);
  // This provider supports native profiling and grouping. Unrelated optional mutations lack evidence;
  // their durable actions still run normally, including relationships and placement checks.
  for (const [key, question] of Object.entries(questions)) {
    const id = key.replace(/^\d+__/, '');
    if (question.type === 'choice' && Object.hasOwn(question.criteria, 'none')
      && (['concept', 'pair', 'canvas', 'person', 'sourceEvidence', 'targetEvidence'].includes(id)
        || /^(specificity|traceability|declaredPurposeCompleteness|internalConsistency)Evidence/.test(id))) {
      result.answers[key] = { type: 'choice', choice: 'none', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(choice => [choice, Number(choice === 'none')])) };
    } else if (question.type === 'noul' && ['supported', 'matches', 'conflict', 'relevance'].includes(id)) {
      result.answers[key] = { type: 'noul', noul: 0.01 };
    } else if (question.type === 'noul' && id.startsWith('label_')) {
      result.answers[key] = { type: 'noul', noul: 0.5 };
    } else if (question.type === 'score') {
      result.answers[key] = { type: 'score', score: 0, confidence: 1,
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, Number(index === 0)])) };
    }
  }
  call.response.setHeader('content-type', 'application/json'); call.response.end(JSON.stringify(result));
}

it('drains active profiles for ready native grouping while another workspace progresses and preserves source ownership', async () => {
  let origin = ''; let fifthGroup: string | undefined;
  const admissions: Evaluation[] = []; const releasedSources = new Set<string>();
  const sourceKey = (evaluation: Evaluation) => `${evaluation.workspaceId}:${evaluation.blockIds.join(',')}`;
  const profiles = () => [...new Map(calls.filter(call => call.action === 'profile' && call.workspaceId === workspaceId)
    .map(call => [sourceKey(call), call])).values()];
  async function releaseSource(call: Call): Promise<void> {
    releasedSources.add(sourceKey(call));
    await Promise.all(calls.filter(candidate => sourceKey(candidate) === sourceKey(call) && !candidate.response.writableEnded).map(release));
  }
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const evaluation = JSON.parse(String(request.headers['x-native-evaluation'])) as Evaluation;
    const call = { ...evaluation, raw, response }; calls.push(call); changed?.();
    if (evaluation.action !== 'profile' || releasedSources.has(sourceKey(evaluation))) await release(call);
  });
  await new Promise<void>((resolve, reject) => { provider!.once('error', reject); provider!.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native admission provider failed');
  origin = `http://127.0.0.1:${address.port}`;
  let firstBlock = ''; let firstFinished = false; let checkedAdmission!: () => void;
  const admission = new Promise<void>(resolve => { checkedAdmission = resolve; });
  // Labeling is source-local; the following link action drains active profiles before filing.
  runtime = new JevRuntime(store, { apiKey: '', startTimer: false, documentExecution: false });
  await runtime.idle();
  // Observe real admission and settlement without replacing provider evaluation or native persistence.
  const observed = runtime as unknown as {
    evaluateJob(context: JevEvaluationContext, job: StoredJevJob): Promise<JevEvaluation>;
    settledExecution(candidate: JevQueuedCandidate): Promise<Outcome>;
    fillExecutions(active: Map<string, unknown>): Promise<void>;
  };
  const evaluate = observed.evaluateJob.bind(runtime);
  observed.evaluateJob = async (context, job) => {
    const evaluation = { workspaceId: context.workspaceId, action: job.request.action, blockIds: job.request.blockIds ?? [] };
    if (evaluation.action === 'profile' && evaluation.workspaceId === workspaceId
      && admissions.filter(item => item.action === 'profile' && item.workspaceId === workspaceId).length === 4) {
      fifthGroup = (await store.getCanvasBlock(canvasId, firstBlock)).group;
    }
    admissions.push(evaluation);
    return scope.run(evaluation, () => evaluate(context, job));
  };
  const settled = observed.settledExecution.bind(runtime); const fill = observed.fillExecutions.bind(runtime);
  observed.settledExecution = async candidate => {
    const outcome = await settled(candidate);
    if (candidate.workspaceId === workspaceId && candidate.job.request.action === 'profile' && candidate.job.request.blockIds?.includes(firstBlock)) firstFinished = true;
    return outcome;
  };
  observed.fillExecutions = async active => { await fill(active); if (firstFinished) checkedAdmission(); };
  runtime.useTransport({ apiKey: 'native-admission-provider', fetcher: (_url, options) => {
    const headers = new Headers(options?.headers); headers.set('x-native-evaluation', JSON.stringify(scope.getStore()));
    return fetch(origin, { ...options, headers });
  } });
  await runtime.reconcile(workspaceId); await runtime.reconcile(otherWorkspaceId);
  await until(() => profiles().length === 4);
  const initial = profiles(); firstBlock = initial[0].blockIds[0];
  await releaseSource(initial[0]); await admission;
  await expect.poll(async () => {
    const queued = await new JevWorkspaceFiles(root).read(workspaceId);
    return queued.jobs.some(job => job.request.action === 'link' && job.request.blockIds?.includes(firstBlock) && job.state === 'queued');
  }).toBe(true);
  expect(profiles()).toHaveLength(4);
  expect(admissions.filter(item => item.action === 'profile' && item.workspaceId === workspaceId)).toHaveLength(4);
  expect(initial.slice(1).every(call => !call.response.writableEnded)).toBe(true);
  await until(() => calls.some(call => call.workspaceId === otherWorkspaceId && call.action === 'profile'));
  const other = calls.find(call => call.workspaceId === otherWorkspaceId && call.action === 'profile')!;
  expect(other.response.writableEnded).toBe(false);
  await Promise.all(initial.slice(1).map(releaseSource));
  await until(() => profiles().length === 5);
  const fifth = profiles()[4];
  const groupAdmission = admissions.findIndex(item => item.workspaceId === workspaceId && item.action === 'file' && item.blockIds.includes(firstBlock));
  const labelAdmission = admissions.findIndex(item => item.workspaceId === workspaceId && item.action === 'label' && item.blockIds.includes(firstBlock));
  const linkAdmission = admissions.findIndex(item => item.workspaceId === workspaceId && item.action === 'link' && item.blockIds.includes(firstBlock));
  const fifthAdmission = admissions.findIndex(item => item.workspaceId === workspaceId && item.action === 'profile' && item.blockIds.includes(fifth.blockIds[0]));
  expect(groupAdmission).toBeGreaterThanOrEqual(0);
  expect(labelAdmission).toBeGreaterThanOrEqual(0);
  expect(labelAdmission).toBeLessThan(linkAdmission);
  expect(linkAdmission).toBeLessThan(groupAdmission);
  expect(groupAdmission).toBeLessThan(fifthAdmission);
  expect(fifthGroup).toMatch(/^custom:/);
  const committed = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(committed.receipts.some(receipt => receipt.after.kind === 'document' && receipt.after.blockId === firstBlock && receipt.after.patch.group === fifthGroup)).toBe(true);
  expect(committed.jobs.filter(job => job.request.blockIds?.includes(firstBlock) && job.state === 'completed')
    .map(job => job.request.action).sort()).toEqual(['profile', 'file', 'label', 'link', 'flag_duplicate', 'suggest_home_canvas'].sort());
  await runtime.shutdown();
  const reloaded = new CanvasStore(root); await reloaded.init();
  for (const document of documents) {
    const saved = await reloaded.getCanvasBlock(canvasId, document.id);
    expect({ content: saved.content, x: saved.x, y: saved.y, tags: saved.tags, reviewer: saved.reviewer,
      sourceGeneration: saved.sourceGeneration, incarnation: saved.incarnation }).toEqual({ content: document.content,
      x: document.x, y: document.y, tags: document.tags, reviewer: document.reviewer,
      sourceGeneration: document.sourceGeneration, incarnation: document.incarnation });
    expect(saved.jevOwnership?.pins).toContain('tags');
    if (document.reviewer) expect(saved.jevOwnership?.pins).toContain('reviewer');
  }
});
