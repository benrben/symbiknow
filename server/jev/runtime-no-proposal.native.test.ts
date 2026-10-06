import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { JevEvaluation, JevJob, JevPrincipal } from '../../shared/jev-types.js';
import type { JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction } from './actions.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
type ProviderBody = { model: string; state: unknown; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string; let requests: ProviderBody[];
let root: string; let store: CanvasStore; let runtime: JevRuntime; let files: JevWorkspaceFiles;
let workspaceId: string; let canvasId: string; let blockId: string;
let released: () => void; let entered: Promise<void>; let result: JevEvaluation;
let observed: JevJob[];
const content = '# Atlas deployment\nDocument the supported Atlas deployment options before choosing a shared group.';

beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as ProviderBody; requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: .01 }];
      if (question.type !== 'choice' || !('none' in question.criteria)) throw new Error('Expected a typed abstaining group decision');
      return [id, { type: 'choice', choice: 'none', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'none' ? 1 : 0])) }];
    }));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native provider did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });

function start(hold: Promise<void>, started: () => void) {
  return new JevRuntime(store, { apiKey: '', startTimer: false, fetcher: (_url, options) => fetch(origin, options),
    evaluate: async (context, request) => {
      // Only this native evaluation has fixture credentials; saved source events cannot start unrelated work.
      context.apiKey = 'native-empty-proposal-provider';
      const evaluation = await evaluateJevAction(context, request); result = structuredClone(evaluation);
      started(); await hold;
      return evaluation;
    } });
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', ''); requests = []; observed = [];
  root = await mkdtemp(path.join(tmpdir(), 'jev-no-proposal-native-'));
  store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Atomic result persistence' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Source evidence' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas deployment', content })).id;
  files = new JevWorkspaceFiles(root);
  let started!: () => void;
  entered = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { released = resolve; });
  runtime = start(hold, started); await runtime.idle();
  const write = JevWorkspaceFiles.prototype.write;
  vi.spyOn(JevWorkspaceFiles.prototype, 'write').mockImplementation(async function(this: JevWorkspaceFiles, id, state) {
    await write.call(this, id, state);
    if (this.file(id) !== files.file(workspaceId)) return;
    const visible = await runtime.read(workspaceId, owner);
    const job = visible.jobs.find(job => job.request.idempotencyKey === 'abstain-group-once');
    if (job) observed.push(structuredClone(job));
  });
});
afterEach(async () => { released(); await runtime.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function running() {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId], idempotencyKey: 'abstain-group-once' }, owner);
  await entered;
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe('jev-1.13.0');
  const group = Object.entries(requests[0].questions).find(([id]) => id.replace(/^(\d+__)+/, '') === 'group');
  expect(group?.[1].type).toBe('choice');
  expect(Object.values(requests[0].questions).some(question => question.type === 'noul')).toBe(true);
  expect(JSON.stringify(requests[0].state)).toContain('Document the supported Atlas deployment options');
  expect(result.proposals).toEqual([]);
  expect(result.result).toMatchObject({ status: 'insufficient_group_evidence', proposalCount: 0,
    documents: { [blockId]: { status: 'insufficient_group_evidence' } } });
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'running' });
  return job;
}

it('publishes an abstaining native result once with completed status and retains exact readback and idempotence after restart', async () => {
  const job = await running(); released(); await runtime.idle();
  const completed = (await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)!;
  expect(completed).toMatchObject({ state: 'completed', result: result.result, proposalIds: [] });
  expect(observed.filter(snapshot => snapshot.result !== undefined).map(snapshot => snapshot.state)).toEqual(['completed']);
  expect(observed).toHaveLength(3);
  const saved = await files.read(workspaceId);
  expect(saved.proposals).toEqual([]); expect(saved.receipts).toEqual([]);
  await runtime.shutdown(); store = new CanvasStore(root); await store.init(); runtime = start(Promise.resolve(), () => undefined);
  expect((await runtime.run(workspaceId, job.request, owner)).id).toBe(job.id); await runtime.idle();
  expect(requests).toHaveLength(1);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).jobs.find(item => item.id === job.id)).toEqual(saved.jobs.find(item => item.id === job.id));
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe(content);
});

it('rejects a human source edit after the native decision without publishing its obsolete result', async () => {
  const job = await running();
  await store.updateBlock(canvasId, blockId, { content: '# Atlas deployment\nHuman revised the deployment options.' }, 'Browser');
  released(); await runtime.idle();
  const failed = (await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)!;
  expect(failed).toMatchObject({ state: 'failed', error: 'The source changed since Symbi Reflex reviewed it' });
  expect(failed.result).toBeUndefined(); expect(observed.some(snapshot => snapshot.result !== undefined)).toBe(false);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas deployment\nHuman revised the deployment options.');
});

it.each(['cancel', 'pause'])('keeps owner %s authoritative after the native decision and before no-proposal completion', async action => {
  const job = await running();
  if (action === 'cancel') await runtime.cancel(workspaceId, job.id, owner);
  else await runtime.configure(workspaceId, { paused: true }, owner);
  released(); await runtime.idle();
  const state = await runtime.read(workspaceId, owner); const cancelled = state.jobs.find(item => item.id === job.id)!;
  expect(cancelled.state).toBe('cancelled'); expect(cancelled.result).toBeUndefined();
  expect(observed.some(snapshot => snapshot.result !== undefined)).toBe(false);
  expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, blockId)).content).toBe(content);
});
