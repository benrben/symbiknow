import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { CanvasBlock } from '../shared/types.js';
import type { FileUploadInput } from '../shared/working-copy.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { operationPath, readJournal, type UploadOperation } from './file-checkout-journal.js';
import { stageJevDraft } from './jev/drafts.js';
import { sourceSnapshot } from './jev/stamps.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';
import { git } from './version-git.js';

/** A faulty adapter saves the source but cannot supply all receipt verification data. */
class UnverifiedSaveStore extends CanvasStore {
  constructor(root: string, private readonly missing: 'content hash' | 'history commit') { super(root); }
  override async createBlock(canvasId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    const block = await super.createBlock(canvasId, input, actor);
    if (this.missing === 'content hash') delete block.contentHash;
    return block;
  }
  override async documentHistory(canvasId: string, blockId: string, options?: { limit?: number; cursor?: number }) {
    const history = await super.documentHistory(canvasId, blockId, options);
    return this.missing === 'history commit' ? { ...history, commits: [] } : history;
  }
}

/** A faulty adapter reports bytes that differ from the source it was asked to save. */
class MismatchedSaveStore extends CanvasStore {
  override async updateBlock(canvasId: string, blockId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    const block = await super.updateBlock(canvasId, blockId, input, actor);
    return { ...block, content: '# Different saved source' };
  }
}

let root: string;
let store: CanvasStore;
let workspaceId: string;
let canvasId: string;
const principal: JevPrincipal = { id: 'file-agent', kind: 'user', access: 'write' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-checkout-coverage-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root);
  await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Working copies' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function replacement(checkoutId: string, content: string, key: string, options: Partial<FileUploadInput> = {}): FileUploadInput {
  return { mode: 'replace', canvasId, checkoutId, filename: 'local.md', content, idempotencyKey: key, ...options };
}
async function website(branch?: string) {
  await mkdir(path.join(root, 'sites/test-site/docs'), { recursive: true });
  await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Website source');
  const block = await store.createBlock(canvasId, { title: 'Site', kind: 'website',
    content: '---\ngenerator: mkdocs\nsource: sites/test-site\n---\n# Website' });
  if (branch) await store.createDocumentBranch(canvasId, block.id, branch);
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch });
  const bundle = JSON.parse(file.content);
  bundle.files[0].content = '# Uploaded website source';
  return { block, file, input: replacement(file.manifest.checkoutId, JSON.stringify(bundle), 'site-upload') };
}
/** Simulate a crash after the source commit but before the receipt reached the journal. */
async function dropReceipt(input: FileUploadInput): Promise<CanvasStore> {
  const journal = operationPath(store, principal.id, input.idempotencyKey);
  const operation = JSON.parse(await readFile(journal, 'utf8'));
  delete operation.receipt;
  await atomicJson(journal, operation, 0o600);
  const restarted = new CanvasStore(root);
  await restarted.init();
  return restarted;
}
const siteSource = () => readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8');
async function expectNoReceipt(input: FileUploadInput): Promise<void> {
  const operation = await readJournal<UploadOperation>(operationPath(store, principal.id, input.idempotencyKey));
  expect(operation).toMatchObject({ callerId: principal.id, input });
  expect(operation!.receipt).toBeUndefined();
}

it('rejects an upload larger than a canvas document before it reads the working copy', async () => {
  const input: FileUploadInput = { mode: 'create', canvasId, filename: 'large.md', content: 'x'.repeat(999_901), idempotencyKey: 'too-large' };
  await expect(commitFileUpload(store, principal, input)).rejects.toMatchObject({ status: 413 });
  expect((await store.getCanvas(canvasId)).blocks).toEqual([]);
});

it('creates a document with the loader detected from its filename and an HTML page with the Markdown loader', async () => {
  const notes = await commitFileUpload(store, principal, { mode: 'create', canvasId, filename: 'notes.mdx', content: '# Notes\n', idempotencyKey: 'detected' });
  expect(notes).toMatchObject({ status: 'saved', saved: true, kind: 'mdx', title: 'notes', branch: 'main', revision: expect.any(String) });
  const page = await commitFileUpload(store, principal, { mode: 'create', canvasId, filename: 'page.md', kind: 'html',
    content: '<main>Page</main>', idempotencyKey: 'html-page' });
  expect(page).toMatchObject({ kind: 'html', filename: page.blockId + '.html' });
  expect(await store.getCanvasBlock(canvasId, page.blockId)).toMatchObject({ kind: 'markdown', content: '---\nformat: html\n---\n<main>Page</main>' });
});

it.each(['content hash', 'history commit'] as const)('refuses a successful receipt when a faulty store omits the saved %s', async missing => {
  store = new UnverifiedSaveStore(root, missing);
  await store.init();
  const input: FileUploadInput = { mode: 'create', canvasId, filename: 'unverified.md', content: '# Unverified', idempotencyKey: 'unverified-save' };
  await expect(commitFileUpload(store, principal, input)).rejects.toMatchObject({
    status: 500, message: 'The saved file revision could not be verified; retry the same upload key',
  });
  expect((await store.getCanvas(canvasId)).blocks).toMatchObject([{ content: input.content }]);
  await expectNoReceipt(input);
});

it('refuses a successful receipt when a replacement save returns different source bytes', async () => {
  const block = await store.createBlock(canvasId, { title: 'Original', content: '# Original' });
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id });
  store = new MismatchedSaveStore(root);
  await store.init();
  const input = replacement(file.manifest.checkoutId, '# Uploaded source', 'mismatched-save');
  await expect(commitFileUpload(store, principal, input)).rejects.toMatchObject({
    status: 500, message: 'Saved file verification failed; retry the same upload key',
  });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(input.content);
  await expectNoReceipt(input);
});

it('refuses a create-upload retry receipt when its saved document repository has a detached HEAD', async () => {
  const input: FileUploadInput = { mode: 'create', canvasId, filename: 'detached.md', content: '# Detached source', idempotencyKey: 'detached-create' };
  const first = await commitFileUpload(store, principal, input);
  store = await dropReceipt(input);
  // Only this test's mkdtemp document repository changes HEAD.
  const repository = path.join(root, '.versions', first.blockId);
  await git(repository, 'checkout', '--detach');
  expect(await git(repository, 'branch', '--show-current')).toBe('');
  expect(await git(repository, 'rev-parse', 'HEAD')).toBe(first.revision);
  await expect(commitFileUpload(store, principal, input)).rejects.toMatchObject({
    status: 500, message: 'The saved file branch could not be verified',
  });
  expect((await store.getCanvas(canvasId)).blocks).toMatchObject([{ id: first.blockId, content: input.content }]);
  await expectNoReceipt(input);
});

it('rejects a working copy after its document was deleted and recreated with the same identifier', async () => {
  const block = await store.createBlock(canvasId, { title: 'Imported', content: '# Imported', idempotencyKey: 'stable-import' });
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id });
  await store.deleteBlock(canvasId, block.id);
  const recreated = await store.createBlock(canvasId, { title: 'Imported', content: '# Imported', idempotencyKey: 'stable-import' });
  expect(recreated.id).toBe(block.id);
  await expect(commitFileUpload(store, principal, replacement(file.manifest.checkoutId, '# Stale edit', 'recreated')))
    .rejects.toMatchObject({ status: 409, message: 'The downloaded document identity changed; download it again' });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe('# Imported');
});

it('refuses a download when an external writer removes the document identity after stamping', async () => {
  const block = await store.createBlock(canvasId, { title: 'Legacy', content: '# Legacy' });
  const canvasFile = path.join(root, 'canvases', canvasId + '.json');
  const ensure = store.ensureJevStamps.bind(store);
  vi.spyOn(store, 'ensureJevStamps').mockImplementation(async id => {
    await ensure(id);
    // A legacy client rewrites the canvas file between the stamp and the read.
    const canvas = JSON.parse(await readFile(canvasFile, 'utf8'));
    for (const item of canvas.blocks) delete item.incarnation;
    await writeFile(canvasFile, JSON.stringify(canvas));
  });
  await expect(checkoutFile(store, principal, { canvasId, blockId: block.id }))
    .rejects.toMatchObject({ status: 409, message: 'Document identity is unavailable; reload before downloading' });
});

it('refuses a replacement while a reviewed draft is active for the document', async () => {
  const block = await store.createBlock(canvasId, { title: 'Reviewed', content: '# Reviewed' });
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id });
  await stageJevDraft(root, sourceSnapshot(workspaceId, canvasId, block),
    { id: 'draft-1', baseContent: block.content, proposedContent: '# Draft', instruction: 'Tighten' }, 'reviewer');
  await expect(commitFileUpload(store, principal, replacement(file.manifest.checkoutId, '# Upload', 'during-draft')))
    .rejects.toMatchObject({ status: 403 });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe('# Reviewed');
});

it('renames and changes the loader of the visible source when the upload names them', async () => {
  const block = await store.createBlock(canvasId, { title: 'Original', content: '# Original' });
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id });
  const receipt = await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, '# Renamed', 'rename', { title: 'Renamed', kind: 'mdx' }));
  expect(receipt).toMatchObject({ title: 'Renamed', kind: 'mdx', branch: 'main' });
  expect(await store.getCanvasBlock(canvasId, block.id)).toMatchObject({ title: 'Renamed', kind: 'mdx', content: '# Renamed' });
});

it('accepts unchanged metadata on a private branch upload and rejects a private rename', async () => {
  const block = await store.createBlock(canvasId, { title: 'Original', kind: 'slides', content: '# Deck' });
  await store.createDocumentBranch(canvasId, block.id, 'agent/deck');
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/deck' });
  const same = { title: 'Original', kind: 'slides' as const };
  const receipt = await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, '# Private deck', 'same-metadata', same));
  expect(receipt).toMatchObject({ branch: 'agent/deck', kind: 'slides', title: 'Original' });
  const next = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/deck' });
  await expect(commitFileUpload(store, principal, replacement(next.manifest.checkoutId, '# Renamed', 'renamed', { title: 'Renamed' })))
    .rejects.toMatchObject({ status: 400, message: 'Private branch uploads preserve document title and loader' });
  expect((await store.readDocumentBranch(canvasId, block.id, 'agent/deck')).content).toBe('# Private deck');
});

it('keeps the website loader when a package replacement asks for another loader', async () => {
  const { input } = await website();
  await expect(commitFileUpload(store, principal, { ...input, kind: 'markdown' }))
    .rejects.toMatchObject({ status: 400, message: 'Website package replacements preserve the website loader' });
  expect(await siteSource()).toBe('# Website source');
});

it('recovers an interrupted visible website upload and refuses recovery after outside asset edits', async () => {
  const { input } = await website();
  const first = await commitFileUpload(store, principal, input);
  const restarted = await dropReceipt(input);
  const recovered = await commitFileUpload(restarted, principal, input);
  expect(recovered).toMatchObject({ operationId: first.operationId, revision: first.revision, filename: first.filename });
  expect(await siteSource()).toBe('# Uploaded website source');
  const again = await dropReceipt(input);
  await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Outside edit');
  await expect(commitFileUpload(again, principal, input))
    .rejects.toMatchObject({ status: 409, message: 'Website assets changed during upload recovery' });
  expect(await siteSource()).toBe('# Outside edit');
});

it('recovers an interrupted private branch website upload without touching the visible assets', async () => {
  const { block, input } = await website('agent/site');
  const first = await commitFileUpload(store, principal, input);
  const restarted = await dropReceipt(input);
  const recovered = await commitFileUpload(restarted, principal, input);
  expect(recovered).toMatchObject({ operationId: first.operationId, revision: first.revision, branch: 'agent/site' });
  expect((await restarted.readDocumentBranch(canvasId, block.id, 'agent/site')).revision).toBe(first.revision);
  expect(await siteSource()).toBe('# Website source');
});
