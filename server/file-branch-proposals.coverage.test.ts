import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { FileUploadInput, FileUploadReceipt } from '../shared/working-copy.js';
import { applyFileProposal, undoFileProposal } from './file-branch-proposals.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
let blockId: string;
const principal: JevPrincipal = { id: 'file-proposer', kind: 'user', access: 'propose' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-proposal-coverage-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Proposals' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Original', content: '# Original' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function download() {
  return checkoutFile(store, principal, { canvasId, blockId });
}
async function propose(options: Partial<FileUploadInput> = {}, file?: Awaited<ReturnType<typeof download>>): Promise<FileUploadReceipt> {
  const downloaded = file ?? await download();
  return commitFileUpload(store, principal, { mode: 'propose', canvasId, checkoutId: downloaded.manifest.checkoutId,
    filename: downloaded.filename, content: '# Reviewed', idempotencyKey: 'proposal-' + Object.keys(options).join('-'), ...options });
}
async function interruptedApply(receipt: FileUploadReceipt, content: string): Promise<void> {
  const current = await store.getCanvasBlock(canvasId, blockId);
  await store.updateBlock(canvasId, blockId, { content, expectedContentHash: current.contentHash,
    message: 'Interrupted proposal [upload:' + receipt.proposalId + '-apply]' }, principal.id);
}

it('proposes, applies, and undoes an HTML page rename on the visible branch with its title and loader', async () => {
  const receipt = await propose({ kind: 'html', title: 'Page', content: '<p>Page</p>' });
  expect(receipt).toMatchObject({ status: 'proposed', saved: false, kind: 'html', title: 'Page', filename: blockId + '.html' });
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ title: 'Original', content: '# Original' });
  const applied = await applyFileProposal(store, receipt.proposalId!) as { receipt: FileUploadReceipt };
  expect(applied.receipt).toMatchObject({ status: 'saved', kind: 'html', title: 'Page', branch: 'main' });
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ title: 'Page', kind: 'markdown', content: '---\nformat: html\n---\n<p>Page</p>' });
  expect(await undoFileProposal(store, receipt.proposalId!)).toMatchObject({ status: 'reverted' });
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ title: 'Original', kind: 'markdown', content: '# Original' });
});

it('rejects a loader proposal after another writer changed the loader', async () => {
  const receipt = await propose({ kind: 'mdx' });
  expect(receipt).toMatchObject({ kind: 'mdx', filename: blockId + '.mdx' });
  await store.updateBlock(canvasId, blockId, { kind: 'slides' });
  await expect(applyFileProposal(store, receipt.proposalId!))
    .rejects.toMatchObject({ status: 409, message: 'The document loader changed since this file proposal' });
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ kind: 'slides', content: '# Original' });
});

it('rejects a title proposal after another writer renamed the document', async () => {
  const receipt = await propose({ title: 'Proposed title' });
  await store.updateBlock(canvasId, blockId, { title: 'Concurrent title' });
  await expect(applyFileProposal(store, receipt.proposalId!))
    .rejects.toMatchObject({ status: 409, message: 'The document title changed since this file proposal' });
  expect(await store.getCanvasBlock(canvasId, blockId)).toMatchObject({ title: 'Concurrent title', content: '# Original' });
});

it('rejects a proposal whose branch changed after the download', async () => {
  const file = await download();
  const current = await store.getCanvasBlock(canvasId, blockId);
  await store.updateBlock(canvasId, blockId, { content: '# Concurrent', expectedContentHash: current.contentHash });
  await expect(propose({}, file)).rejects.toMatchObject({ status: 409, message: 'The proposal branch changed since download' });
});

it('refuses to recover an interrupted apply whose committed source differs from the proposal', async () => {
  const receipt = await propose();
  await interruptedApply(receipt, '# Different interrupted source');
  await expect(applyFileProposal(store, receipt.proposalId!))
    .rejects.toMatchObject({ status: 409, message: 'The interrupted proposal source changed; review it again' });
  expect((await store.getCanvasBlock(canvasId, blockId)).content).toBe('# Different interrupted source');
});

it('refuses to recover an interrupted website apply after outside asset edits', async () => {
  await mkdir(path.join(root, 'sites/test-site/docs'), { recursive: true });
  const asset = path.join(root, 'sites/test-site/docs/index.md');
  await writeFile(asset, '# Website source');
  blockId = (await store.createBlock(canvasId, { title: 'Site', kind: 'website',
    content: '---\ngenerator: mkdocs\nsource: sites/test-site\n---\n# Website' })).id;
  const file = await download();
  const bundle = JSON.parse(file.content);
  bundle.documentContent += '\nReviewed configuration';
  bundle.files[0].content = '# Proposed asset';
  const receipt = await propose({ content: JSON.stringify(bundle) }, file);
  await interruptedApply(receipt, bundle.documentContent);
  await writeFile(asset, '# Outside edit');
  await expect(applyFileProposal(store, receipt.proposalId!))
    .rejects.toMatchObject({ status: 409, message: 'Website assets changed during proposal recovery' });
  expect(await readFile(asset, 'utf8')).toBe('# Outside edit');
});
