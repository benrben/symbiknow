import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { JevEvaluation,JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import type { JevEvaluator } from './actions/context.js';
import { stageJevDraft } from './drafts.js';
import { JevRuntime,getJevRuntime } from './runtime.js';
import { sourceSnapshot } from './stamps.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let blockId: string;
const evaluate: JevEvaluator = async (context, request): Promise<JevEvaluation> => {
  const document = context.documents.find(item => item.block.id === blockId)!;
  const evidence = { source: document.snapshot, start: 0, end: 7, quote: '# Atlas' };
  const mutation = { kind: 'document' as const, canvasId, blockId, patch: { group: 'custom:atlas' } };
  return { result: { state: 'ready' }, proposals: [{ action: request.action, title: 'Reviewed change', explanation: 'Exact source evidence',
    evidence: [evidence], sources: [document.snapshot], confidence: 0.99, mutation }] };
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-public-native-')); store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Public boundaries' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' })).id;
  runtime = new JevRuntime(store, { evaluate, startTimer: false });
  await runtime.configure(workspaceId, { modes: { file: 'auto', link: 'auto' } as never }, owner);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(root, { recursive: true, force: true }); });
async function proposal() {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner); await runtime.idle();
  return (await runtime.read(workspaceId, owner)).proposals.find(item => item.jobId === job.id)!;
}
it('validates reviewer configuration, workspace schedule scope, and read-only action grants before work admission', async () => {
  const credential = await store.createMcpToken('Reader', 'read', { allowedCanvasIds: [canvasId] });
  const principal: JevPrincipal = { ...(await store.mcpTokenIdentity(credential.token))!, kind: 'token' };
  await expect(runtime.configure(workspaceId, { paused: true }, principal)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.configure(workspaceId, { schedules: [{ id: 'bad', canvasIds: ['missing'], time: '09:00', timezone: 'UTC', enabled: true }] }, owner)).rejects.toMatchObject({ status: 400 });
  await expect(runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, principal)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.read('missing', owner)).rejects.toMatchObject({ status: 404 });
  expect((await runtime.read(workspaceId, owner)).jobs).toEqual([]);
});
it('revises only a checked pending target, removes prior confidence, and requires fresh review for changed source bytes', async () => {
  const pending = await proposal();
  await expect(runtime.revise(workspaceId, 'missing', pending.mutation, owner)).rejects.toMatchObject({ status: 404 });
  await expect(runtime.revise(workspaceId, pending.id, { kind: 'document', canvasId, blockId: 'different', patch: { group: 'custom:changed' } }, owner)).rejects.toMatchObject({ status: 409 });
  const revised = await runtime.revise(workspaceId, pending.id, { kind: 'document', canvasId, blockId, patch: { group: 'custom:reviewed' } }, owner);
  expect(revised.confidence).toBeUndefined();
  await store.updateBlock(canvasId, blockId, { content: '# Atlas manually changed' });
  await expect(runtime.revise(workspaceId, pending.id, revised.mutation, owner)).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('keeps another initiator’s durable draft private and checks exact document workspace scope', async () => {
  const source = await store.getCanvasBlock(canvasId, blockId);
  await stageJevDraft(root, sourceSnapshot(workspaceId, canvasId, source),
    { id: 'private-draft', baseContent: source.content, proposedContent: '# Private proposed content', instruction: 'Clarify' }, owner.id);
  const credential = await store.createMcpToken('Agent', 'propose', { allowedCanvasIds: [canvasId], tools: ['jev_propose'] });
  const principal: JevPrincipal = { ...(await store.mcpTokenIdentity(credential.token))!, kind: 'token' };
  await expect(runtime.readDraft(workspaceId, canvasId, blockId, principal)).rejects.toMatchObject({ status: 403 });
  await expect(runtime.readDraft('other-workspace', canvasId, blockId, owner)).rejects.toMatchObject({ status: 404 });
  await expect(runtime.readDraft(workspaceId, canvasId, 'missing-block', owner)).rejects.toMatchObject({ status: 404 });
  await expect(runtime.setMetadata('other-workspace', canvasId, blockId, { group: 'custom:wrong' }, owner)).rejects.toMatchObject({ status: 404 });
  expect((await store.getCanvasBlock(canvasId, blockId)).group).toBeUndefined();
});
it('returns one runtime per store and updates an existing transport without creating another worker', async () => {
  runtime.close(); await runtime.idle();
  runtime = getJevRuntime(store, { evaluate, startTimer: false }); await runtime.idle();
  const decider = async () => { throw new Error('Local fixture evaluator does not invoke the provider'); };
  expect(getJevRuntime(store, { decider, apiKey: 'fixture-provider' })).toBe(runtime);
  expect(getJevRuntime(store)).toBe(runtime);
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [blockId] }, owner);
  await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('completed');
  expect(await runtime.readDraft(workspaceId, canvasId, blockId, owner)).toBeNull();
});
