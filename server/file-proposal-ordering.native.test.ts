import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { applyFileProposal, undoFileProposal } from './file-branch-proposals.js';
import { JevWorkspaceFiles } from './jev/workspace.js';
import { withinApiMutationAuthority } from './api-mutation-authority.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function appliedProposal() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-proposal-ordering-'));
  roots.push(root);
  const store = new CanvasStore(root); await store.init();
  await store.ensureJevStamps('product-roadmap');
  const canvas = await store.getCanvas('product-roadmap');
  const draft = new ChatProposalDraft(store, canvas.id, canvas);
  draft.patch('launch-checklist', { content: '# Reviewed checklist\nSource one.' }, 'edit');
  draft.patch('roadmap-overview', { content: '# Reviewed overview\nSource two.' }, 'edit');
  const proposal = draft.publish()!;
  await applyFileProposal(store, proposal.id);
  return { store, canvas, proposal };
}

it('waits for the workspace before holding the writer during a two-source proposal Undo', async () => {
  const { store, canvas, proposal } = await appliedProposal();
  const files = new JevWorkspaceFiles(store.root);
  let entered!: () => void; let release!: () => void; let requested!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { requested = resolve; });
  const events: string[] = [];
  const blocker = files.serial(canvas.workspaceId, async () => {
    entered(); await gate; events.push('workspace released');
  });
  await inside;
  const transaction = JevWorkspaceFiles.prototype.transaction;
  vi.spyOn(JevWorkspaceFiles.prototype, 'transaction').mockImplementation(function (this: JevWorkspaceFiles, workspaceId, operation) {
    requested(); return transaction.call(this, workspaceId, operation);
  });
  const undo = undoFileProposal(store, proposal.id);
  await waiting;
  const independent = store.jevExecutor.serialized(async () => { events.push('independent writer'); });
  // The independent writer contains no I/O; drain its microtasks before releasing the held workspace.
  await new Promise<void>(resolve => setImmediate(resolve));
  release();
  const [, result] = await Promise.all([blocker, undo, independent]);
  expect(events).toEqual(['independent writer', 'workspace released']);
  expect(result).toMatchObject({ status: 'reverted', reverted: ['launch-checklist', 'roadmap-overview'] });
  const reloaded = await new CanvasStore(store.root).getCanvas(canvas.id);
  expect(reloaded.blocks.map(block => [block.id, block.content])).toEqual(canvas.blocks.map(block => [block.id, block.content]));
  for (const block of reloaded.blocks) {
    expect(block.incarnation).toBe(canvas.blocks.find(before => before.id === block.id)!.incarnation);
  }
});

it('rechecks revoked request authority after waiting for the proposal workspace', async () => {
  const { store, canvas, proposal } = await appliedProposal();
  const applied = await store.getCanvas(canvas.id);
  const files = new JevWorkspaceFiles(store.root);
  let entered!: () => void; let release!: () => void; let requested!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { requested = resolve; });
  const blocker = files.serial(canvas.workspaceId, async () => { entered(); await gate; });
  await inside;
  const transaction = JevWorkspaceFiles.prototype.transaction;
  vi.spyOn(JevWorkspaceFiles.prototype, 'transaction').mockImplementation(function (this: JevWorkspaceFiles, workspaceId, operation) {
    requested(); return transaction.call(this, workspaceId, operation);
  });
  let allowed = true;
  const undo = withinApiMutationAuthority(async () => {
    if (!allowed) throw new Error('Source grant revoked while waiting');
  }, () => undoFileProposal(store, proposal.id));
  const rejected = expect(undo).rejects.toThrow('Source grant revoked while waiting');
  await waiting; allowed = false; release();
  await Promise.all([blocker, rejected]);
  expect(await new CanvasStore(store.root).getCanvas(canvas.id)).toEqual(applied);
  expect(await undoFileProposal(store, proposal.id)).toMatchObject({ status: 'reverted' });
});
