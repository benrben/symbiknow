import { mkdtemp,rm } from 'node:fs/promises';
import { createServer,type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { JevCurrentAction,JevActionRequest,JevPrincipal,JevSettings } from '../../shared/jev-types.js';
import type { JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { evaluateJevAction } from './actions.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let provider: Server; let root: string; let store: CanvasStore; let runtime: JevRuntime;
let workspaceId: string; let canvasId: string; let support: number; let providerCalls: number;
function answer(id: string, question: JevQuestion) {
  if (question.type === 'noul') {
    const negative = ['unrelatedDeletion', 'unsupportedClaim', 'requirementConflict', 'addressesAi'].includes(id) || id.startsWith('conflict_');
    return { type: 'noul', noul: negative ? 0.02 : support };
  }
  if (question.type === 'score') return { type: 'score', score: 1, confidence: 0.67,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 1 ? 1 : 0])) };
  const keys = Object.keys(question.criteria);
  const specific: Record<string, string> = { place: 'B', gate: 'B', impact: 'urgent' };
  const selected = specific[id] ?? keys[0];
  return { type: 'choice', choice: selected, confidence: 0.67,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}
beforeEach(async () => {
  support = 0.83; providerCalls = 0;
  provider = createServer(async (request, response) => {
    providerCalls += 1; let raw = ''; for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { questions: Record<string, JevQuestion> };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [id, answer(id, question)])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Provider unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'reflex-supported-native-'));
  store = new CanvasStore(root); await store.init();
  await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Supported autonomy' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  runtime = new JevRuntime(store, { startTimer: false, evaluate: (context, request) => {
    context.apiKey = 'native-provider'; return evaluateJevAction(context, request);
  },
    fetcher: (url, options) => fetch(`${origin}${new URL(String(url)).pathname}`, options) });
});
afterEach(async () => {
  await runtime.shutdown(); provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
async function configure(actions: JevCurrentAction[], extra: Partial<JevSettings> = {}) {
  await runtime.configure(workspaceId, { externalProcessing: true,
    confidenceThresholds: Object.fromEntries(actions.map(action => [action, 0.65])),
    modes: Object.fromEntries(actions.map(action => [action, 'auto'])) as JevSettings['modes'], ...extra }, owner);
}
async function run(request: JevActionRequest) {
  const job = await runtime.run(workspaceId, request, owner); await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', error: undefined });
  return { ...state, latestJob: state.jobs.find(item => item.id === job.id)! };
}
it('automatically moves a supported home and attached work within scope with a durable checked inverse', async () => {
  const source = await store.createBlock(canvasId, { title: 'Delivery', content: 'This delivery belongs with release work.' });
  const task = await store.createTask(canvasId, { title: 'Delivery', detail: 'Track delivery.', blockIds: [source.id] }, 'Browser');
  const target = await store.createCanvas(workspaceId, { name: 'Release work' });
  await configure(['suggest_home_canvas']);
  const state = await run({ action: 'suggest_home_canvas', canvasId, blockIds: [source.id] });
  expect((await new CanvasStore(root).getCanvasBlock(target.id, source.id)).content).toBe(source.content);
  expect((await store.listTasks(target.id))[0].blockIds).toEqual([source.id]);
  expect((await store.listTasks(canvasId)).find(item => item.id === task.id)?.blockIds).toEqual([]);
  const receipt = state.receipts.find(item => item.action === 'suggest_home_canvas')!; expect(receipt.automatic).toBe(true);
  await runtime.undo(workspaceId, receipt.id, owner);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).content).toBe(source.content);
  expect((await store.listTasks(canvasId)).find(item => item.id === task.id)?.blockIds).toEqual([source.id]);
  expect(await store.listTasks(target.id)).toEqual([]);
});
it('files supported groups with a checked inverse while removed taxonomy requests preserve the saved organization', async () => {
  const source = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas\nAtlas launch process.' });
  await configure(['file']);
  const state = await run({ action: 'file', canvasId, blockIds: [source.id] });
  const term = state.vocabulary.find(item => item.name === 'Atlas')!;
  const saved = await store.getCanvasBlock(canvasId, source.id);
  expect(saved.group).toBe('custom:atlas');
  const calls = providerCalls;
  await expect(runtime.run(workspaceId, { action: 'vocab_lifecycle', canvasId,
    options: { operation: 'rename', termId: term.id, name: 'Launch' } }, owner)).rejects.toMatchObject({ status: 400 });
  expect(providerCalls).toBe(calls);
  expect(await store.getCanvasBlock(canvasId, source.id)).toEqual(saved);
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual(state.receipts);
  const receipt = state.receipts.find(item => item.action === 'file' && item.after.kind === 'document')!;
  expect(receipt.automatic).toBe(true); await runtime.undo(workspaceId, receipt.id, owner);
  const restored = await new CanvasStore(root).getCanvasBlock(canvasId, source.id);
  expect(restored.group).toBe(source.group); expect(restored.content).toBe(source.content);
});
it('retains checked managed links when removed rechecks are requested and still supports Undo', async () => {
  const source = await store.createBlock(canvasId, { title: 'Delivery', content: 'Atlas delivery implements the launch plan.' });
  const target = await store.createBlock(canvasId, { title: 'Launch plan', content: 'Atlas launch plan defines delivery.' });
  await configure(['link']);
  const state = await run({ action: 'link', canvasId, blockIds: [source.id] });
  expect((await store.getCanvasBlock(canvasId, source.id)).links).toEqual([target.id]);
  const calls = providerCalls; support = 0.02;
  await expect(runtime.run(workspaceId, { action: 'recheck_links', canvasId, blockIds: [source.id] }, owner)).rejects.toMatchObject({ status: 400 });
  expect(providerCalls).toBe(calls);
  expect((await store.getCanvasBlock(canvasId, source.id)).links).toEqual([target.id]);
  const receipt = state.receipts.find(item => item.action === 'link' && item.after.kind === 'document')!;
  expect(receipt.automatic).toBe(true); await runtime.undo(workspaceId, receipt.id, owner);
  expect((await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).links).toEqual([]);
});
it.each(['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall'] as const)(
  'rejects removed %s before creating jobs, receipts, provider requests or document changes', async action => {
    const source = await store.createBlock(canvasId, { title: 'Manual source', content: '# Preserve source',
      group: 'custom:manual', tags: ['Manual'], x: 123, y: 456 });
    await runtime.idle();
    const before = await runtime.read(workspaceId, owner); const calls = providerCalls;
    const saved = await store.getCanvasBlock(canvasId, source.id);
    await expect(runtime.run(workspaceId, { action, canvasId, blockIds: [source.id] }, owner)).rejects.toMatchObject({ status: 400 });
    expect(providerCalls).toBe(calls);
    expect(await runtime.read(workspaceId, owner)).toEqual(before);
    expect(await new CanvasStore(root).getCanvasBlock(canvasId, source.id)).toEqual(saved);
  });
