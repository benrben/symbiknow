import { execFile } from 'node:child_process';
import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { atomicJson } from './storage-files.js';
import { CanvasStore } from './storage.js';
import { createWebsite, exportWebsite, replaceWebsite, type WebsitePackage } from './website-working-copy.js';

// Inject one native rename failure (for example EXDEV on a cross-device move); every other call is real.
const fault = vi.hoisted(() => ({ source: undefined as string | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: PathLike, to: PathLike) => {
    if (fault.source && String(from).endsWith(fault.source)) {
      fault.source = undefined;
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
    }
    return actual.rename(from, to);
  } };
});

let root: string;
let store: CanvasStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-website-copy-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root); await store.init();
  await mkdir(path.join(root, 'sites'));
  await writeFile(path.join(root, 'sites/plain.txt'), 'Not a folder');
});
afterEach(async () => { fault.source = undefined; await rm(root, { recursive: true, force: true }); });

const documentFor = (source: string) => `---\ngenerator: mkdocs\nsource: ${source}\n---\n# Website`;
function bundle(source: string, content = '# New source'): WebsitePackage {
  return { format: 'symbi-website', version: 1, documentContent: documentFor(source), files: [{ path: 'docs/index.md', encoding: 'utf8', content }] };
}
async function site(name: string) {
  await mkdir(path.join(root, 'sites', name, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'sites', name, 'docs/index.md'), '# Original source');
  return documentFor('sites/' + name);
}
const leftovers = async () => (await readdir(path.join(root, 'sites'))).filter(name => /\.(upload|backup)-/.test(name));

it('surfaces a native source folder error other than a missing folder unchanged', async () => {
  await expect(exportWebsite(store, documentFor('sites/plain.txt/docs'))).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it('rejects a website source that contains a named pipe instead of a regular file', async () => {
  const document = await site('piped');
  await promisify(execFile)('mkfifo', [path.join(root, 'sites/piped/docs/events.pipe')]);
  await expect(exportWebsite(store, document)).rejects.toMatchObject({ status: 400, message: 'Website packages require regular files: docs/events.pipe' });
});

it('surfaces native errors from the creation path and an unreadable creation marker unchanged', async () => {
  const save = vi.fn(async () => 'saved');
  await expect(createWebsite(store, bundle('sites/plain.txt/child'), 'blocked-create', save)).rejects.toMatchObject({ code: 'ENOTDIR' });
  await mkdir(path.join(root, 'file-package-creates', 'marker-create.json'), { recursive: true });
  await expect(createWebsite(store, bundle('sites/marker'), 'marker-create', save)).rejects.toMatchObject({ code: 'EISDIR' });
  expect(save).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, 'sites'))).toEqual(['plain.txt']);
});

it('finishes a retried creation that stopped before its source folder was placed', async () => {
  const save = vi.fn(async () => 'saved');
  fault.source = 'sites/created.upload-retried-create';
  await expect(createWebsite(store, bundle('sites/created'), 'retried-create', save)).rejects.toMatchObject({ code: 'EXDEV' });
  expect(save).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, 'sites'))).not.toContain('created');
  expect(await createWebsite(store, bundle('sites/created'), 'retried-create', save)).toBe('saved');
  expect(save).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(root, 'sites/created/docs/index.md'), 'utf8')).toBe('# New source');
  expect(await leftovers()).toEqual([]);
});

it('replaces source files and removes temporary folders with the default operation ID', async () => {
  const document = await site('default-replace');
  await writeFile(path.join(root, 'sites/default-replace/docs/removed.md'), '# Obsolete source');
  const expected = (await exportWebsite(store, document)).packageHash;
  const replacement = bundle('sites/default-replace', '# Replacement');
  const asset = Buffer.from([0, 255, 1, 128]);
  replacement.files.push({ path: 'assets/image.bin', encoding: 'base64', content: asset.toString('base64') });
  const saved = { id: 'saved-website' };
  const save = vi.fn(async () => saved);

  expect(await replaceWebsite(store, document, replacement, expected, save)).toBe(saved);
  expect(save).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(root, 'sites/default-replace/docs/index.md'), 'utf8')).toBe('# Replacement');
  expect(await readFile(path.join(root, 'sites/default-replace/assets/image.bin'))).toEqual(asset);
  expect(await readdir(path.join(root, 'sites/default-replace/docs'))).toEqual(['index.md']);
  expect(await leftovers()).toEqual([]);
});

it('restores the original source folder when the staged replacement cannot be moved into place', async () => {
  const document = await site('replaced');
  const expected = (await exportWebsite(store, document)).packageHash;
  const save = vi.fn(async () => 'saved');
  fault.source = 'sites/replaced.upload-failed-replace';
  await expect(replaceWebsite(store, document, bundle('sites/replaced', '# Replacement'), expected, save, 'failed-replace'))
    .rejects.toMatchObject({ code: 'EXDEV' });
  expect(save).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, 'sites/replaced/docs/index.md'), 'utf8')).toBe('# Original source');
  expect(await leftovers()).toEqual([]);
});
