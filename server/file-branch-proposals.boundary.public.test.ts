import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { atomicJson } from './storage-files.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { applyFileProposal, fileProposalCanvas, getFileProposal, undoFileProposal } from './file-branch-proposals.js';
import { operationPath } from './file-checkout-journal.js';
import type { FileUploadInput, FileUploadReceipt, WorkingCopyManifest } from '../shared/working-copy.js';
import type { JevPrincipal } from '../shared/jev-types.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
let blockId: string;
const principal: JevPrincipal = { id: 'native-file-author', kind: 'user', access: 'propose' };
const branch = 'agent/review';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-branch-review-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Branch review' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Original', content: '# Original' })).id;
  await store.createDocumentBranch(canvasId, blockId, branch);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function draft(options: Partial<FileUploadInput> = {}, targetBranch = branch) {
  const downloaded = await checkoutFile(store, principal, { canvasId, blockId, branch: targetBranch });
  const input: FileUploadInput = { mode: 'propose', canvasId, checkoutId: downloaded.manifest.checkoutId,
    filename: downloaded.filename, content: '# Reviewed', idempotencyKey: randomUUID(), ...options };
  const receipt = await commitFileUpload(store, principal, input);
  return { input, receipt, id: receipt.proposalId! };
}
function journal(id: string) { return path.join(root, 'file-branch-proposals', id + '.json'); }
type ProposalJournal = { checkout: WorkingCopyManifest; status: string; receipt?: FileUploadReceipt; expiresAt: string };
async function rewrite(id: string, edit: (value: ProposalJournal) => void) {
  const value = JSON.parse(await readFile(journal(id), 'utf8'));
  edit(value); await writeFile(journal(id), JSON.stringify(value));
}

it('rejects invalid and missing proposal identities without changing the source', async () => {
  for (const lookup of [getFileProposal, fileProposalCanvas, applyFileProposal, undoFileProposal]) {
    await expect(lookup(store, '../escape')).rejects.toMatchObject({ status: 400 });
    await expect(lookup(store, randomUUID())).rejects.toMatchObject({ status: 410 });
  }
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Original');
});
it.each([{ title: 'Changed title' }, { kind: 'mdx' as const }])('preserves private branch metadata instead of accepting %j', async options => {
  await expect(draft(options)).rejects.toMatchObject({ status: 400 });
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).content).toBe('# Original');
});
it('requires the exact document selection and makes apply and undo retries idempotent', async () => {
  const { id } = await draft();
  await expect(undoFileProposal(store, id)).rejects.toMatchObject({ status: 409 });
  for (const selection of [[], ['foreign'], [blockId, 'foreign']]) {
    await expect(applyFileProposal(store, id, selection)).rejects.toMatchObject({ status: 400 });
  }
  expect(await fileProposalCanvas(store, id)).toBe(canvasId);
  const applied = await applyFileProposal(store, id, [blockId]);
  const revision = (await store.readDocumentBranch(canvasId, blockId, branch)).revision;
  expect(await applyFileProposal(store, id)).toEqual(applied);
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).revision).toBe(revision);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Original');
  const undone = await undoFileProposal(store, id);
  expect(await undoFileProposal(store, id)).toEqual(undone);
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).content).toBe('# Original');
});
it('rejects apply after a concurrent branch edit and undo after a later edit', async () => {
  const first = await draft();
  await store.editDocumentBranch(canvasId, blockId, branch, { content: '# Concurrent',
    expectedContentHash: (await store.readDocumentBranch(canvasId, blockId, branch)).contentHash }, 'concurrent-author');
  await expect(applyFileProposal(store, first.id)).rejects.toMatchObject({ status: 409 });
  const next = await draft({ content: '# Second review' });
  await applyFileProposal(store, next.id);
  await store.editDocumentBranch(canvasId, blockId, branch, { content: '# Later edit',
    expectedContentHash: (await store.readDocumentBranch(canvasId, blockId, branch)).contentHash }, 'later-author');
  await expect(undoFileProposal(store, next.id)).rejects.toMatchObject({ status: 409 });
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).content).toBe('# Later edit');
});
it('rejects a changed source incarnation even when the branch revision still matches', async () => {
  const { id } = await draft();
  await rewrite(id, value => { value.checkout.incarnation = randomUUID(); });
  await expect(applyFileProposal(store, id)).rejects.toMatchObject({ status: 409 });
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).content).toBe('# Original');
});
it('recovers proposal and apply journals after restart without duplicate saved revisions', async () => {
  const { input, id } = await draft();
  const operation = operationPath(store, principal.id, input.idempotencyKey);
  const pending = JSON.parse(await readFile(operation, 'utf8')); delete pending.receipt;
  await writeFile(operation, JSON.stringify(pending));
  store = new CanvasStore(root); await store.init();
  expect((await commitFileUpload(store, principal, input)).proposalId).toBe(id);
  const applied = await applyFileProposal(store, id) as { receipt: FileUploadReceipt };
  const revision = (await store.readDocumentBranch(canvasId, blockId, branch)).revision;
  await rewrite(id, value => { value.status = 'pending'; delete value.receipt; });
  store = new CanvasStore(root); await store.init();
  expect(await applyFileProposal(store, id)).toMatchObject({ status: 'applied',
    receipt: { operationId: applied.receipt.operationId, revision, contentHash: applied.receipt.contentHash } });
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).revision).toBe(revision);
  await undoFileProposal(store, id);
  const reverted = (await store.readDocumentBranch(canvasId, blockId, branch)).revision;
  await rewrite(id, value => { value.status = 'applied'; });
  await undoFileProposal(store, id);
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).revision).toBe(reverted);
});
it('uses the visible branch if switched before review and falls back to canonical current-file proposals', async () => {
  const privateDraft = await draft();
  await store.switchDocumentBranch(canvasId, blockId, branch);
  await applyFileProposal(store, privateDraft.id);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Reviewed');
  await undoFileProposal(store, privateDraft.id);
  const visible = await draft({ content: '# Visible review' }, branch);
  expect(await fileProposalCanvas(store, visible.id)).toBe(canvasId);
  expect(await getFileProposal(store, visible.id)).toMatchObject({ status: 'pending' });
  await applyFileProposal(store, visible.id);
  expect(await fileProposalCanvas(store, visible.id)).toBe(canvasId);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Visible review');
  await undoFileProposal(store, visible.id);
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Original');
});
it('refuses expired private proposals before applying any content', async () => {
  const { id } = await draft();
  await rewrite(id, value => { value.expiresAt = new Date(0).toISOString(); });
  await expect(applyFileProposal(store, id)).rejects.toMatchObject({ status: 410 });
  expect((await store.readDocumentBranch(canvasId, blockId, branch)).content).toBe('# Original');
});
