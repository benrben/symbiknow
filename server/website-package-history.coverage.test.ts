import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../shared/jev-types.js';
import { checkoutFile } from './file-checkouts.js';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';
import { changeWebsiteVersion, saveWebsiteRevision, websiteRevision } from './website-package-history.js';
import type { WebsitePackage } from './website-working-copy.js';

let root: string;
let store: CanvasStore;
let canvasId: string;
const principal: JevPrincipal = { id: 'site-agent', kind: 'user', access: 'write' };
const documentContent = '---\ngenerator: mkdocs\nsource: sites/test-site\n---\n# Website';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-package-history-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Sites' });
  canvasId = (await store.createCanvas(workspace.id, { name: 'Projects' })).id;
  await mkdir(path.join(root, 'sites/test-site/docs'), { recursive: true });
  await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Website source');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('rejects website revision identities that are not a document ID and a Git revision', async () => {
  const bundle: WebsitePackage = { format: 'symbi-website', version: 1, documentContent, files: [] };
  await expect(saveWebsiteRevision(store, '../escape', 'a'.repeat(40), bundle)).rejects.toMatchObject({ status: 400, message: 'Invalid website revision identity' });
  await expect(websiteRevision(store, 'site', 'HEAD', documentContent)).rejects.toMatchObject({ status: 400 });
});

it('refuses to change website versions while source assets have uncommitted outside edits', async () => {
  const block = await store.createBlock(canvasId, { title: 'Site', kind: 'website', content: documentContent });
  await checkoutFile(store, principal, { canvasId, blockId: block.id });
  await store.createDocumentBranch(canvasId, block.id, 'agent/site');
  await writeFile(path.join(root, 'sites/test-site/docs/index.md'), '# Outside edit');
  const change = vi.fn(async () => {
    await store.switchDocumentBranch(canvasId, block.id, 'agent/site', principal.id);
    return store.documentHistory(canvasId, block.id);
  });
  await expect(changeWebsiteVersion(store, canvasId, block.id, 'switch', 'agent/site', principal.id, change))
    .rejects.toMatchObject({ status: 409, message: 'Website source assets have uncommitted changes; upload or preserve them before changing versions' });
  expect(change).not.toHaveBeenCalled();
  expect((await store.documentHistory(canvasId, block.id)).current).toBe('main');
  expect(await readFile(path.join(root, 'sites/test-site/docs/index.md'), 'utf8')).toBe('# Outside edit');
});
