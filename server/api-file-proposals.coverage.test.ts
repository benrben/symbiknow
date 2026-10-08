import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { symbiApiHeaders } from './jev-api-principal.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
let blockId: string;
let api: typeof fetch;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-file-proposal-route-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Routes' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Review' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Source', content: '# Before' })).id;
  api = createStoreApiFetcher(store);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function call(proposalId: string, operation?: 'apply' | 'undo', requested = canvasId) {
  const response = operation
    ? await api(`http://symbi.internal/api/file-proposals/${proposalId}/${operation}`, { method: 'POST',
      headers: { ...symbiApiHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ canvasId: requested }) })
    : await api(`http://symbi.internal/api/file-proposals/${proposalId}?canvasId=${requested}`, { headers: symbiApiHeaders() });
  return { status: response.status, value: await response.json() };
}

it('reads, applies, and undoes a Chat proposal on the visible branch with a saved readback', async () => {
  const draft = new ChatProposalDraft(store, canvasId, await store.getCanvas(canvasId));
  draft.patch(blockId, { content: '# Chat edit' }, 'edit');
  const proposal = draft.publish()!;
  expect(await call(proposal.id)).toMatchObject({ status: 200, value: { id: proposal.id, status: 'pending' } });
  const applied = await call(proposal.id, 'apply');
  const appliedRevision = (await store.readDocumentBranch(canvasId, blockId, 'main')).revision;
  expect(applied).toMatchObject({ status: 200, value: { status: 'applied', canvasId, blockId, branch: 'main', revision: appliedRevision, saved: true } });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Chat edit');
  const undone = await call(proposal.id, 'undo');
  expect(undone).toMatchObject({ status: 200, value: { status: 'reverted', blockId, branch: 'main', saved: true } });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Before');
});

it('returns a repeated undo of a reverted file proposal as stored and hides it from another canvas', async () => {
  const author: JevPrincipal = { id: 'file-proposer', kind: 'user', access: 'propose' };
  const file = await checkoutFile(store, author, { canvasId, blockId });
  const receipt = await commitFileUpload(store, author, { mode: 'propose', canvasId, checkoutId: file.manifest.checkoutId,
    filename: file.filename, content: '# Proposed', idempotencyKey: 'route-proposal' });
  const id = receipt.proposalId!;
  expect(await call(id, 'apply')).toMatchObject({ status: 200, value: { status: 'applied', branch: 'main', saved: true } });
  expect(await call(id, 'undo')).toMatchObject({ status: 200, value: { status: 'reverted', saved: true } });
  const repeated = await call(id, 'undo');
  expect(repeated).toEqual({ status: 200, value: { id, canvasId, branch: 'main', status: 'reverted', reverted: [blockId], skipped: [] } });
  expect(await call(id, undefined, 'another-canvas')).toEqual({ status: 404, value: { error: 'File proposal not found in the requested canvas' } });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Before');
});
