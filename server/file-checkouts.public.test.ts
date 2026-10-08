import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { FileUploadInput } from '../shared/working-copy.js';
import { applyFileProposal, fileProposalCanvas, getFileProposal, undoFileProposal } from './file-branch-proposals.js';
import { changeWebsiteVersion } from './website-package-history.js';
import { checkoutFile, commitFileUpload } from './file-checkouts.js';
import { operationPath } from './file-checkout-journal.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
const principal: JevPrincipal = { id: 'file-agent', kind: 'user', access: 'write' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-working-copy-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root);
  await store.init();
  const workspace = await store.createWorkspace({ name: 'Working copies' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Sources' })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function working(kind: 'markdown' | 'mdx' | 'slides' | 'website' = 'markdown', content = '# Source\r\nExact bytes.\r\n') {
  if (kind === 'website') {
    content = '---\ngenerator: mkdocs\nsource: sites/test-site\n---\n# Website';
    await mkdir(path.join(root, 'sites/test-site/docs'), { recursive: true });
    await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Website source');
  }
  const block = await store.createBlock(canvasId, { title: 'Original title', kind, content, tags: ['preserved'], x: 20, y: 30 });
  return { block, file: await checkoutFile(store, principal, { canvasId, blockId: block.id }) };
}
function replacement(checkoutId: string, content: string, key = 'replace-once'): FileUploadInput {
  return { mode: 'replace', canvasId, checkoutId, filename: 'local.md', content, idempotencyKey: key };
}
it.each(['markdown', 'mdx', 'slides', 'website'] as const)('round trips %s with exact source and original loader despite local filename', async kind => {
  const { block, file } = await working(kind);
  expect(kind === 'website' ? JSON.parse(file.content).documentContent : file.content).toBe(block.content);
  expect(file.manifest).toMatchObject({ callerId: principal.id, documentId: block.id, canvasId, kind, incarnation: block.incarnation, baseContentHash: block.contentHash });
  expect(file.filename.endsWith(kind === 'website' ? '.symbi-site.json' : kind === 'mdx' ? '.mdx' : '.md')).toBe(true);
  const receipt = await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, file.content));
  const saved = await store.getCanvasBlock(canvasId, block.id);
  expect(saved).toMatchObject({ content: block.content, kind, title: 'Original title', x: 20, y: 30, tags: ['preserved'] });
  expect(receipt).toMatchObject({ blockId: block.id, contentHash: saved.contentHash, branch: 'main', revision: expect.any(String), kind, filename: file.filename });
});
it('preserves HTML source frontmatter and exports an HTML filename', async () => {
  const { block, file } = await working('markdown', '---\nformat: html\n---\n<html><body>Page</body></html>\n');
  expect(file.manifest.kind).toBe('html');
  expect(file.filename).toBe(block.id + '.html');
  await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, file.content));
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(file.content);
});
it('commits to a private branch without replacing the visible source', async () => {
  const { block } = await working('slides');
  await store.createDocumentBranch(canvasId, block.id, 'agent/draft');
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/draft' });
  const receipt = await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, '# Draft\n', 'branch-write'));
  expect(receipt).toMatchObject({ branch: 'agent/draft', kind: 'slides' });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  expect((await store.readDocumentBranch(canvasId, block.id, 'agent/draft')).content).toBe('# Draft\n');
});
it('rejects stale files, caller changes, missing checkout and explicit create with a checkout', async () => {
  const { block, file } = await working();
  const input = replacement(file.manifest.checkoutId, '# Local edit');
  await expect(commitFileUpload(store, { ...principal, id: 'other-agent' }, input)).rejects.toMatchObject({ status: 403 });
  await expect(commitFileUpload(store, principal, { ...input, checkoutId: undefined })).rejects.toMatchObject({ status: 400 });
  await expect(commitFileUpload(store, principal, { ...input, mode: 'create' })).rejects.toMatchObject({ status: 400 });
  await store.updateBlock(canvasId, block.id, { content: '# Someone else', expectedContentHash: block.contentHash });
  await expect(commitFileUpload(store, principal, input)).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe('# Someone else');
});
it('returns durable retry receipts after restart without duplicate revisions and rejects key reuse', async () => {
  const { block, file } = await working();
  const input = replacement(file.manifest.checkoutId, '# Saved edit\n');
  const first = await commitFileUpload(store, principal, input);
  const beforeRetry = (await store.documentHistory(canvasId, block.id)).commits;
  const restarted = new CanvasStore(root);
  await restarted.init();
  expect(await commitFileUpload(restarted, principal, input)).toEqual(first);
  expect((await restarted.documentHistory(canvasId, block.id)).commits).toEqual(beforeRetry);
  await expect(commitFileUpload(restarted, principal, { ...input, content: '# Different' })).rejects.toMatchObject({ status: 409 });
});
it('recovers a saved upload whose receipt persistence was interrupted', async () => {
  const { block, file } = await working();
  const input = replacement(file.manifest.checkoutId, '# Saved before interruption');
  const first = await commitFileUpload(store, principal, input);
  const journal = operationPath(store, principal.id, input.idempotencyKey);
  const operation = JSON.parse(await readFile(journal, 'utf8'));
  delete operation.receipt;
  await atomicJson(journal, operation, 0o600);
  const beforeRetry = (await store.documentHistory(canvasId, block.id)).commits;
  const restarted = new CanvasStore(root);
  await restarted.init();
  const recovered = await commitFileUpload(restarted, principal, input);
  expect(recovered).toMatchObject({ operationId: first.operationId, revision: first.revision, contentHash: first.contentHash });
  expect((await restarted.documentHistory(canvasId, block.id)).commits).toEqual(beforeRetry);
});
it('enforces scope and permissions before returning an old receipt', async () => {
  const { file } = await working();
  const input = replacement(file.manifest.checkoutId, '# Changed');
  await commitFileUpload(store, principal, input);
  await expect(commitFileUpload(store, { ...principal, access: 'read' }, input)).rejects.toMatchObject({ status: 403 });
  await expect(commitFileUpload(store, { ...principal, allowedCanvasIds: [] }, input)).rejects.toMatchObject({ status: 404 });
  await expect(checkoutFile(store, { ...principal, tools: [] }, { canvasId, blockId: file.manifest.documentId })).rejects.toMatchObject({ status: 403 });
});
it('creates explicitly and idempotently, and leaves proposal-only source unchanged', async () => {
  const created = await commitFileUpload(store, principal, { mode: 'create', canvasId, filename: 'deck.md', kind: 'slides',
    content: '# Deck\n', idempotencyKey: 'new-deck' });
  expect(await commitFileUpload(store, principal, { mode: 'create', canvasId, filename: 'deck.md', kind: 'slides',
    content: '# Deck\n', idempotencyKey: 'new-deck' })).toEqual(created);
  const limited = { ...principal, access: 'propose' as const };
  const file = await checkoutFile(store, limited, { canvasId, blockId: created.blockId });
  const proposal = await commitFileUpload(store, limited, { ...replacement(file.manifest.checkoutId, '# Proposed deck'), mode: 'propose' });
  expect(proposal.proposalId).toEqual(expect.any(String));
  expect((await store.getCanvasBlock(canvasId, created.blockId)).content).toBe('# Deck\n');
});

it('edits website text and binary assets with a unique revision and rejects package traversal or concurrent file changes', async () => {
  const { block, file } = await working('website');
  const bundle = JSON.parse(file.content);
  bundle.files[0].content = '# Edited website source';
  bundle.files.push({ path: 'assets/pixel.bin', encoding: 'base64', content: Buffer.from([0, 1, 255]).toString('base64') });
  const input = replacement(file.manifest.checkoutId, JSON.stringify(bundle), 'website-assets');
  const receipt = await commitFileUpload(store, principal, input);
  expect(receipt.revision).not.toBe(file.manifest.baseRevision);
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Edited website source');
  expect(await readFile(path.join(root, 'sites/test-site/assets/pixel.bin'))).toEqual(Buffer.from([0, 1, 255]));
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  const next = await checkoutFile(store, principal, { canvasId, blockId: block.id });
  const malicious = JSON.parse(next.content);
  malicious.files.push({ path: '../outside.md', encoding: 'utf8', content: 'escape' });
  await expect(commitFileUpload(store, principal, replacement(next.manifest.checkoutId, JSON.stringify(malicious), 'bad-path'))).rejects.toMatchObject({ status: 400 });
  await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Concurrent external edit');
  await expect(commitFileUpload(store, principal, replacement(next.manifest.checkoutId, next.content, 'concurrent-assets'))).rejects.toMatchObject({ status: 409 });
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Concurrent external edit');
});

it('keeps website branch asset edits private until merge and restores the baseline assets', async () => {
  const { block, file } = await working('website');
  await store.createDocumentBranch(canvasId, block.id, 'agent/site');
  const branch = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/site' });
  const bundle = JSON.parse(branch.content);
  bundle.files[0].content = '# Private site edit';
  const receipt = await commitFileUpload(store, principal, replacement(branch.manifest.checkoutId, JSON.stringify(bundle), 'private-site'));
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Website source');
  const reread = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/site' });
  expect(JSON.parse(reread.content).files[0].content).toBe('# Private site edit');
  expect(reread.manifest.baseRevision).toBe(receipt.revision);
  await changeWebsiteVersion(store, canvasId, block.id, 'merge', 'agent/site', principal.id,
    () => store.mergeDocumentBranch(canvasId, block.id, 'agent/site', principal.id));
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Private site edit');
  await changeWebsiteVersion(store, canvasId, block.id, 'restore', file.manifest.baseRevision, principal.id,
    () => store.restoreDocumentRevision(canvasId, block.id, file.manifest.baseRevision, principal.id));
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Website source');
});
it.each(['switch', 'merge', 'restore'] as const)('compensates %s source, branch heads, and assets when the website revision receipt cannot persist', async kind => {
  const { block, file } = await working('website');
  await store.createDocumentBranch(canvasId, block.id, 'agent/failed-site-version');
  const draft = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/failed-site-version' });
  const bundle = JSON.parse(draft.content);
  bundle.documentContent += '\nPrivate configuration';
  bundle.files[0].content = '# Private version assets';
  await commitFileUpload(store, principal, replacement(draft.manifest.checkoutId, JSON.stringify(bundle), 'failed-version-draft'));
  if (kind === 'restore') {
    const active = JSON.parse(file.content); active.files[0].content = '# Current assets';
    await commitFileUpload(store, principal, replacement(file.manifest.checkoutId, JSON.stringify(active), 'active-before-restore'));
  }
  const before = await store.documentHistory(canvasId, block.id);
  const privateRevision = (await store.readDocumentBranch(canvasId, block.id, 'agent/failed-site-version')).revision;
  const source = (await store.getCanvasBlock(canvasId, block.id)).content;
  const assets = await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8');
  const target = kind === 'restore' ? file.manifest.baseRevision : 'agent/failed-site-version';
  const change = async () => {
    if (kind === 'switch') await store.switchDocumentBranch(canvasId, block.id, target, principal.id);
    else if (kind === 'merge') await store.mergeDocumentBranch(canvasId, block.id, target, principal.id);
    else await store.restoreDocumentRevision(canvasId, block.id, target, principal.id);
    // A native filesystem failure after HEAD changed must compensate all shared state.
    const snapshots = path.join(root, 'file-packages', block.id);
    await rm(snapshots, { recursive: true }); await writeFile(snapshots, 'Receipt storage became unavailable');
    return store.documentHistory(canvasId, block.id);
  };
  await expect(changeWebsiteVersion(store, canvasId, block.id, kind, target, principal.id, change)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await store.documentHistory(canvasId, block.id)).toEqual(before);
  expect((await store.readDocumentBranch(canvasId, block.id, 'agent/failed-site-version')).revision).toBe(privateRevision);
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(source);
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe(assets);
});
it('reviews and reverses an asset-only website proposal without changing files before approval', async () => {
  const { block } = await working('website');
  const limited = { ...principal, access: 'propose' as const };
  const file = await checkoutFile(store, limited, { canvasId, blockId: block.id });
  const bundle = JSON.parse(file.content);
  bundle.files[0].content = '# Proposed website asset';
  const receipt = await commitFileUpload(store, limited, { ...replacement(file.manifest.checkoutId, JSON.stringify(bundle), 'site-proposal'), mode: 'propose' });
  expect(receipt.proposalId).toBeTruthy();
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Website source');
  await applyFileProposal(store, receipt.proposalId!);
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Proposed website asset');
  await undoFileProposal(store, receipt.proposalId!);
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Website source');
});
it.each(['main', 'agent/interrupted-site'])('recovers an interrupted website proposal source commit on %s before returning a save receipt', async branch => {
  const { block } = await working('website');
  if (branch !== 'main') await store.createDocumentBranch(canvasId, block.id, branch);
  const file = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch });
  const bundle = JSON.parse(file.content);
  bundle.documentContent += '\nReviewed source configuration';
  bundle.files[0].content = '# Recovered proposal asset';
  const receipt = await commitFileUpload(store, principal, { ...replacement(file.manifest.checkoutId, JSON.stringify(bundle), 'interrupted-site-proposal'), mode: 'propose' });
  const patch = { content: bundle.documentContent, expectedContentHash: block.contentHash,
    message: 'Interrupted proposal [upload:' + receipt.proposalId + '-apply]' };
  if (branch === 'main') await store.updateBlock(canvasId, block.id, patch, principal.id);
  else await store.editDocumentBranch(canvasId, block.id, branch, patch, principal.id);
  store = new CanvasStore(root); await store.init();
  const applied = await applyFileProposal(store, receipt.proposalId!, undefined, principal.id);
  expect(applied).toMatchObject({ status: 'applied' });
  const saved = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch });
  expect(JSON.parse(saved.content).files[0].content).toBe('# Recovered proposal asset');
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe(branch === 'main' ? '# Recovered proposal asset' : '# Website source');
  const revision = saved.manifest.baseRevision;
  await applyFileProposal(store, receipt.proposalId!);
  expect((await store.readDocumentBranch(canvasId, block.id, branch)).revision).toBe(revision);
});

it('proposes, applies, and reverses private branch content without changing visible source', async () => {
  const { block } = await working('mdx');
  await store.createDocumentBranch(canvasId, block.id, 'agent/proposed');
  const limited = { ...principal, access: 'propose' as const };
  const file = await checkoutFile(store, limited, { canvasId, blockId: block.id, branch: 'agent/proposed' });
  const receipt = await commitFileUpload(store, limited, { ...replacement(file.manifest.checkoutId, '# Proposed branch', 'branch-propose'), mode: 'propose' });
  expect(await fileProposalCanvas(store, receipt.proposalId!)).toBe(canvasId);
  expect(await getFileProposal(store, receipt.proposalId!)).toMatchObject({ status: 'pending', branch: 'agent/proposed' });
  await applyFileProposal(store, receipt.proposalId!);
  expect((await store.readDocumentBranch(canvasId, block.id, 'agent/proposed')).content).toBe('# Proposed branch');
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
  await undoFileProposal(store, receipt.proposalId!);
  expect((await store.readDocumentBranch(canvasId, block.id, 'agent/proposed')).content).toBe(block.content);
  expect(await getFileProposal(store, receipt.proposalId!)).toMatchObject({ status: 'reverted' });
});
it('reviews private branch website assets without changing the active project', async () => {
  const { block } = await working('website');
  await store.createDocumentBranch(canvasId, block.id, 'agent/proposed-site');
  const limited = { ...principal, access: 'propose' as const };
  const file = await checkoutFile(store, limited, { canvasId, blockId: block.id, branch: 'agent/proposed-site' });
  const bundle = JSON.parse(file.content);
  bundle.files[0].content = '# Proposed private website';
  const receipt = await commitFileUpload(store, limited, { ...replacement(file.manifest.checkoutId, JSON.stringify(bundle), 'private-package-propose'), mode: 'propose' });
  await applyFileProposal(store, receipt.proposalId!);
  const saved = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/proposed-site' });
  expect(JSON.parse(saved.content).files[0].content).toBe('# Proposed private website');
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Website source');
  await undoFileProposal(store, receipt.proposalId!);
  const restored = await checkoutFile(store, principal, { canvasId, blockId: block.id, branch: 'agent/proposed-site' });
  expect(JSON.parse(restored.content).files[0].content).toBe('# Website source');
});

it('rechecks token authorization after waiting in the writer queue', async () => {
  const { block } = await working();
  const created = await store.createMcpToken('Queued file agent', 'write');
  const identity = await store.mcpTokenIdentity(created.token);
  const token: JevPrincipal = { ...identity!, kind: 'token' };
  const file = await checkoutFile(store, token, { canvasId, blockId: block.id });
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = store.jevExecutor.serialized(async () => { entered(); await gate; });
  await ready;
  const upload = commitFileUpload(store, token, replacement(file.manifest.checkoutId, '# Revoked upload', 'revoked-queued'));
  const denied = expect(upload).rejects.toMatchObject({ status: 403 });
  const settings = await store.secretSettings();
  // Another server process can revoke the token while this process is waiting for its writer.
  await atomicJson(path.join(root, 'settings.json'), { ...settings, mcpTokens: [] }, 0o600);
  release();
  await writer;
  await denied;
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe(block.content);
});
it('creates a complete website package and returns the same durable save receipt on retry', async () => {
  const content = JSON.stringify({ format: 'symbi-website', version: 1,
    documentContent: '---\ngenerator: mkdocs\nsource: sites/new-project\n---\n# New website',
    files: [{ path: 'docs/index.md', encoding: 'utf8', content: '# New source file' }] });
  const input: FileUploadInput = { mode: 'create', canvasId, filename: 'new.symbi-site.json', kind: 'website', content, idempotencyKey: 'create-website' };
  const receipt = await commitFileUpload(store, principal, input);
  expect(receipt).toMatchObject({ status: 'saved', saved: true, filename: receipt.blockId + '.symbi-site.json', kind: 'website' });
  expect(await readFile(path.join(root, 'sites/new-project/docs/index.md'), 'utf8')).toBe('# New source file');
  expect(await commitFileUpload(store, principal, input)).toEqual(receipt);
  const file = await checkoutFile(store, principal, { canvasId, blockId: receipt.blockId });
  expect(JSON.parse(file.content).files[0].content).toBe('# New source file');
});
