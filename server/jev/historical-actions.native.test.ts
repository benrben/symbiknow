import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';
import { proposalKey } from './proposals.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
it.each(['set_headline', 'vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall'] as const)('restores saved historical %s output through checked Undo after its action was removed', async action => {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-historical-undo-'));
  const store = new CanvasStore(root); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Historical saved work' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' });
  const runtime = new JevRuntime(store, { startTimer: false, evaluate: async context => {
    const document = context.documents.find(item => item.block.id === block.id)!;
    return { result: {}, proposals: [{ action: 'file', title: 'Saved legacy metadata', explanation: 'Exact historical source',
      sources: [document.snapshot], evidence: [{ source: document.snapshot, start: 0, end: 7, quote: '# Atlas' }],
      mutation: { kind: 'document', canvasId, blockId: block.id, patch: { headline: '# Atlas' } } }] };
  } });
  try {
    const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
    const files = new JevWorkspaceFiles(root); const pending = (await files.read(workspaceId)).proposals.find(item => item.jobId === job.id)!;
    const receipt = await runtime.apply(workspaceId, pending.id, owner);
    const history = await files.read(workspaceId);
    history.receipts.find(item => item.id === receipt.id)!.action = action;
    history.proposals.find(item => item.id === pending.id)!.action = action;
    history.jobs.find(item => item.id === job.id)!.request.action = action;
    await files.write(workspaceId, history);
    await expect(runtime.run(workspaceId, { action, canvasId }, owner)).rejects.toMatchObject({ status: 400 });
    await runtime.undo(workspaceId, receipt.id, owner);
    const saved = await new CanvasStore(root).getCanvasBlock(canvasId, block.id);
    expect(saved.headline).toBeUndefined(); expect(saved.content).toBe(block.content);
    expect((await files.read(workspaceId)).receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it('preserves historical task suppression keys across regenerated IDs, clocks and finding-reference positions', () => {
  const base = { action: 'create_task_from_line', mutation: { kind: 'task_create', canvasId: 'canvas', task: {
    id: 'old-task', title: 'Check release', detail: 'Exact release evidence', status: 'todo', blockIds: ['source'],
    createdAt: '2025-01-01', updatedAt: '2025-01-02', revision: 1, jevMutationId: 'old-write',
    findingRef: { key: 'saved-finding', references: ['old-position'] } } } } as unknown as JevProposal;
  const replay = structuredClone(base);
  if (replay.mutation.kind !== 'task_create') throw new Error('Task history fixture required');
  Object.assign(replay.mutation.task, { id: 'new-task', createdAt: '2026-01-01', updatedAt: '2026-01-02', revision: 2, jevMutationId: 'new-write' });
  replay.mutation.task.findingRef!.references = [];
  expect(proposalKey(replay)).toBe(proposalKey(base));
  delete replay.mutation.task.findingRef;
  expect(proposalKey(replay)).not.toBe(proposalKey(base));
});
