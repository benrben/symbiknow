import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { JevRuntime } from './runtime.js';
import type { JevQueuedCandidate } from './runtime-scheduler.js';
import { JevWorkspaceFiles } from './workspace.js';

type ProviderCall = { response: ServerResponse; questions: Record<string, JevQuestion> };
type NativeFixture = { root: string; store: CanvasStore; workspaceId: string; canvasId: string; sources: CanvasBlock[] };
type ExecutionOutcome = { candidate: JevQueuedCandidate; failed: boolean; error?: unknown };
let provider: Server; let origin: string; let runtime: JevRuntime | undefined;
let calls: ProviderCall[] = []; let arrived: (() => void) | undefined;
let fixture: NativeFixture | undefined; let stateFile: string | undefined; let backup: string | undefined;

function responseAnswer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.01 };
  const keys = question.type === 'score' ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria);
  const choice = question.type === 'choice' && 'none' in question.criteria ? 'none' : keys[0];
  const probabilities = Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice, confidence: 0.99, probabilities }
    : { type: 'score', score: 0, confidence: 0.99, probabilities };
}
function release(call: ProviderCall) {
  if (call.response.destroyed || call.response.writableEnded) return;
  call.response.setHeader('content-type', 'application/json');
  call.response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(call.questions).map(([id, question]) => [id, responseAnswer(question)])) }));
}
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as { questions: Record<string, JevQuestion> };
    const call = { response, questions: body.questions };
    if (!Object.keys(body.questions).some(id => id.replace(/^(\d+__)+/, '') === 'role')) {
      release(call); return;
    }
    calls.push(call); arrived?.();
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native failure provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); calls = []; arrived = undefined;
  runtime = undefined; fixture = undefined; stateFile = undefined; backup = undefined;
});
afterEach(async () => {
  calls.forEach(release); await runtime?.shutdown();
  if (backup && stateFile) { await rm(stateFile, { recursive: true, force: true }); await rename(backup, stateFile); }
  provider.closeAllConnections();
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
afterAll(async () => { await new Promise<void>(resolve => provider.close(() => resolve())); });

async function nativeFixture(count: number): Promise<NativeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-parallel-failure-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Native parallel failure' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Independent sources' })).id;
  const sources = await Promise.all(Array.from({ length: count }, (_, index) => store.createBlock(canvasId, {
    title: `Atlas source ${index}`, content: `# Atlas source ${index}\nReviewed Atlas rollout requirements.`,
    tags: ['manual-reviewed'], x: 128 + index * 500, y: 256,
  }, 'Browser')));
  return { root, store, workspaceId, canvasId, sources };
}
async function startHeldProfiles(count: number) {
  fixture = await nativeFixture(count);
  // Preserve parallel worker failure coverage for the supported per-action execution path.
  runtime = new JevRuntime(fixture.store, { apiKey: '', startTimer: false, documentExecution: false }); await runtime.idle();
  let allArrived!: () => void; let firstFailure!: (error: unknown) => void;
  const received = new Promise<void>(resolve => { allArrived = resolve; });
  const failed = new Promise<unknown>(resolve => { firstFailure = resolve; });
  arrived = () => { if (calls.length === count) allArrived(); };
  // Observe actual settled execution without replacing its provider calls, I/O, or error behavior.
  const observed = runtime as unknown as { settledExecution(candidate: JevQueuedCandidate): Promise<ExecutionOutcome> };
  const settledExecution = observed.settledExecution.bind(runtime);
  observed.settledExecution = async candidate => {
    const outcome = await settledExecution(candidate);
    if (outcome.failed) firstFailure(outcome.error);
    return outcome;
  };
  runtime.useTransport({ apiKey: 'local-failure-provider', fetcher: (_url, options) => fetch(origin, options) });
  await runtime.reconcile(fixture.workspaceId); await received;
  expect(calls).toHaveLength(count);
  expect(calls.every(call => Object.keys(call.questions).some(id => id.replace(/^(\d+__)+/, '') === 'role'))).toBe(true);
  expect((await runtime.read(fixture.workspaceId)).jobs.filter(job => job.state === 'running')).toHaveLength(count);
  stateFile = new JevWorkspaceFiles(fixture.root).file(fixture.workspaceId); backup = stateFile + '.before';
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let completed = false;
  const idle = runtime.idle().then(() => { completed = true; return undefined; }, error => { completed = true; return error as unknown; });
  await rename(stateFile, backup); await mkdir(stateFile);
  return { received: failed, idle, completed: () => completed, errors };
}
async function restoreAndVerify() {
  await runtime!.shutdown();
  await rm(stateFile!, { recursive: true }); await rename(backup!, stateFile!); backup = undefined;
  const state = await new JevWorkspaceFiles(fixture!.root).read(fixture!.workspaceId);
  expect(state.prepared).toEqual([]);
  expect(state.jobs).toHaveLength(fixture!.sources.length);
  expect(state.jobs.every(job => job.state === 'running')).toBe(true);
  const fresh = await new CanvasStore(fixture!.root).getCanvas(fixture!.canvasId, true, false);
  expect(fresh.blocks.map(block => ({ content: block.content, x: block.x, y: block.y, tags: block.tags,
    sourceGeneration: block.sourceGeneration, incarnation: block.incarnation }))).toEqual(fixture!.sources.map(block => ({
    content: block.content, x: block.x, y: block.y, tags: block.tags, sourceGeneration: block.sourceGeneration, incarnation: block.incarnation })));
  expect(fresh.blocks.every(block => block.jevOwnership?.pins.includes('tags'))).toBe(true);
}

it('waits for every held parallel SDK call after native persistence fails and preserves all failures together', async () => {
  const held = await startHeldProfiles(3);
  release(calls[0]); const originalFailure = await held.received;
  expect(originalFailure).toMatchObject({ code: 'EISDIR' });
  await Promise.resolve(); await Promise.resolve();
  expect(held.completed()).toBe(false);
  expect(calls.slice(1).every(call => !call.response.writableEnded)).toBe(true);
  calls.slice(1).forEach(release);
  const failure = await held.idle;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(3);
  expect((failure as AggregateError).errors).toContain(originalFailure);
  expect((failure as AggregateError).errors.every(error => error.code === 'EISDIR')).toBe(true);
  expect(held.errors).toHaveBeenCalledWith('Symbi Reflex queue requires recovery; saved knowledge is intact.');
  await restoreAndVerify();
});

it('retains the original native persistence error when the failed worker has no parallel peers', async () => {
  const held = await startHeldProfiles(1);
  release(calls[0]); expect(await held.received).toMatchObject({ code: 'EISDIR' });
  const failure = await held.idle;
  expect(failure).toMatchObject({ code: 'EISDIR' });
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(held.errors).toHaveBeenCalledWith('Symbi Reflex queue requires recovery; saved knowledge is intact.');
  await restoreAndVerify();
});
