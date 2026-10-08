import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { atomicJson } from '../storage-files.js';
import { CanvasStore } from '../storage.js';
import type { JevEvaluator } from './actions/context.js';
import { automationPrincipal } from './authorization.js';
import { JevProposalExecutor,proposalKey } from './proposals.js';
import { enqueueJevJob } from './runtime-queue.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blockId: string;
const evaluate: JevEvaluator = async (context, request) => {
  const document = context.documents.find(item => item.block.id === blockId)!;
  return { result: {}, proposals: [{ action: request.action, title: 'Supported organization', explanation: 'Exact local source', confidence: 0.99,
    sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId, blockId, patch: { group: 'custom:atlas' } } }] };
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-runtime-boundary-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Runtime boundary' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  runtime = new JevRuntime(store, { startTimer: false, evaluate });
  await runtime.configure(workspaceId, { modes: { file: 'auto', profile: 'auto' } as never }, owner);
});
afterEach(async () => { runtime.close(); await runtime.idle().catch(() => undefined); vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function request() { return { action: 'file' as const, canvasId, blockIds: [blockId] }; }
async function replaceEvaluator(next: JevEvaluator, apiKey?: string) {
  runtime.close(); await runtime.idle(); runtime = new JevRuntime(store, { startTimer: false, evaluate: next, apiKey }); await runtime.idle();
}
async function admit(principal: JevPrincipal) {
  runtime.close(); await runtime.idle(); const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
  return files.serial(workspaceId, () => enqueueJevJob(store, files, executor, workspaceId, request(), principal));
}
it('holds owner Auto without a configured processing provider and rejects repeated or missing dismissals', async () => {
  await replaceEvaluator(evaluate, '');
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  const job = await runtime.run(workspaceId, request(), owner); await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed' });
  const proposal = state.proposals.find(item => state.jobs.find(item => item.id === job.id)!.proposalIds.includes(item.id))!;
  expect(proposal.automaticHoldReason).toBe('A configured processing provider is required');
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
  await expect(runtime.dismiss(workspaceId, 'missing', owner)).rejects.toMatchObject({ status: 404 });
  await runtime.dismiss(workspaceId, proposal.id, owner);
  await expect(runtime.dismiss(workspaceId, proposal.id, owner)).rejects.toMatchObject({ status: 409 });
});
it('refreshes durable token grants before consuming a queued request', async () => {
  const credential = await store.createMcpToken('Scoped agent', 'propose', { allowedCanvasIds: [canvasId], tools: ['jev_do', 'jev_activity'] });
  const principal: JevPrincipal = { ...(await store.mcpTokenIdentity(credential.token))!, kind: 'token', canApprove: false, canConfigure: false };
  const job = await admit(principal);
  const file = path.join(root, 'settings.json'); const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.mcpTokens.find((token: { id: string }) => token.id === principal.id).tools = ['jev_do'];
  await atomicJson(file, settings, 0o600);
  runtime = new JevRuntime(store, { startTimer: false, evaluate }); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The authorization changed while the action was queued' });
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('refuses an older process’s queued action when the persisted processing policy changed', async () => {
  const job = await admit(owner); const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  state.settings.externalProcessing = false; await files.write(workspaceId, state);
  runtime = new JevRuntime(store, { startTimer: false, evaluate }); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)).toMatchObject({ state: 'failed', error: 'The processing policy changed' });
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('aborts an overlong provider operation through its real signal and preserves saved knowledge', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  await replaceEvaluator(async context => { began(); await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true })); return { result: {}, proposals: [] }; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const job = await runtime.run(workspaceId, request(), owner); await started; await vi.advanceTimersByTimeAsync(15001); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('failed');
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
});
it('uses a durable job identity for automatic profile continuations that have no caller operation key', async () => {
  await replaceEvaluator(async (context, req) => req.action === 'profile' ? { result: {}, proposals: [] } : evaluate(context, req));
  const job = await runtime.run(workspaceId, { action: 'profile', canvasId, blockIds: [blockId] }, automationPrincipal); await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)?.state).toBe('completed');
  expect(state.jobs.some(item => item.request.idempotencyKey?.startsWith(`${job.id}:`) && item.request.action === 'file')).toBe(true);
});
it('reports a damaged analysis journal without changing the independently saved document', async () => {
  const file = path.join(root, 'jev', 'workspaces', workspaceId, 'state.json'); let original!: string;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await replaceEvaluator(async () => { original = await readFile(file, 'utf8'); await writeFile(file, '{ damaged journal'); return { result: {}, proposals: [] }; });
  await runtime.run(workspaceId, request(), owner); await expect(runtime.idle()).rejects.toMatchObject({ status: 503 });
  expect(errors).toHaveBeenCalledWith('Symbi Reflex queue requires recovery; saved knowledge is intact.');
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source');
  await writeFile(file, original);
});
it('keeps provider failure details private while allowing cancellation to retain its terminal state', async () => {
  await replaceEvaluator(async () => { throw new Error('Private provider response bytes'); });
  const failed = await runtime.run(workspaceId, request(), owner); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === failed.id)).toMatchObject({
    state: 'failed', error: 'Symbi Reflex could not complete the operation; Retry is available' });
  let began!: () => void; let resume!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }); const pending = new Promise<void>(resolve => { resume = resolve; });
  await replaceEvaluator(async () => { began(); await pending; throw new Error('Aborted provider response'); });
  const job = await runtime.run(workspaceId, request(), owner); await started;
  await runtime.cancel(workspaceId, job.id, owner); resume(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('cancelled');
});
it('honors a cancellation queued immediately after admission without reviving the claimed job', async () => {
  let calls = 0; await replaceEvaluator(async () => { calls += 1; return { result: {}, proposals: [] }; });
  const job = await runtime.run(workspaceId, request(), owner); await runtime.cancel(workspaceId, job.id, owner); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('cancelled');
  expect(calls).toBe(0);
});
it('reports failed startup and maintenance journals while keeping the source readable', async () => {
  runtime.close(); await runtime.idle(); const file = path.join(root, 'jev', 'workspaces', workspaceId, 'state.json');
  const original = await readFile(file, 'utf8'); const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await writeFile(file, '{ damaged startup'); runtime = new JevRuntime(store, { startTimer: false, evaluate });
  await expect(runtime.idle()).rejects.toMatchObject({ status: 503 });
  expect(errors).toHaveBeenCalledWith('Symbi Reflex startup requires recovery; ordinary knowledge remains available.');
  runtime.close(); await writeFile(file, original);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  runtime = new JevRuntime(store, { evaluate }); await runtime.idle();
  await writeFile(file, '{ damaged maintenance'); await vi.advanceTimersByTimeAsync(60000);
  await expect.poll(() => errors.mock.calls.some(call => call[0] === 'Symbi Reflex maintenance needs Retry.'), { timeout: 1000 }).toBe(true);
  expect(errors).toHaveBeenCalledWith('Symbi Reflex maintenance needs Retry.');
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas source'); await writeFile(file, original);
});
it('deduplicates suppression of an older pair of equivalent review cards without losing either review decision', async () => {
  const job = await runtime.run(workspaceId, request(), owner); await runtime.idle();
  const files = new JevWorkspaceFiles(root); const state = await files.read(workspaceId);
  const original = state.proposals.find(item => item.jobId === job.id)!;
  const legacy = { ...structuredClone(original), id: 'legacy-equivalent-review-card' }; state.proposals.push(legacy); await files.write(workspaceId, state);
  await runtime.suppress(workspaceId, original.id, owner); await runtime.suppress(workspaceId, legacy.id, owner);
  const saved = await files.read(workspaceId); expect(saved.suppressions).toEqual([proposalKey(original)]);
  expect(saved.proposals.map(item => item.state)).toEqual(['suppressed', 'suppressed']);
});
it('aborts its own active provider work on close while keeping primary source writes available', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  await replaceEvaluator(async context => { began(); await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true })); return { result: {}, proposals: [] }; });
  const job = await runtime.run(workspaceId, request(), owner); await started; runtime.close(); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('failed');
  await store.updateBlock(canvasId, blockId, { content: '# Atlas saved after shutdown' });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas saved after shutdown');
});
it('cancels an active job when the owner changes workspace policy before approval', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  await replaceEvaluator(async context => { began(); await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true })); return { result: {}, proposals: [] }; });
  const job = await runtime.run(workspaceId, request(), owner); await started;
  await runtime.configure(workspaceId, { paused: true }, owner); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('cancelled');
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('preserves a successful source save even when the secondary analysis scheduler encounters a damaged journal', async () => {
  const file = path.join(root, 'jev', 'workspaces', workspaceId, 'state.json'); const original = await readFile(file, 'utf8');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await writeFile(file, '{ damaged source scheduler');
  await store.updateBlock(canvasId, blockId, { content: '# Atlas successfully saved' }, owner.id);
  await expect.poll(() => errors.mock.calls.some(call => call[0] === 'Jev could not schedule saved knowledge; reconciliation will retry.'), { timeout: 1000 }).toBe(true);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Atlas successfully saved');
  await writeFile(file, original); await runtime.reconcile(workspaceId); await runtime.idle();
});
