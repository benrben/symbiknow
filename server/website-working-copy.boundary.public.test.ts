import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { atomicJson } from './storage-files.js';
import { createWebsite, exportWebsite, packageHash, parseWebsite, readWebsiteDirectory, replaceWebsite } from './website-working-copy.js';
import { operationCommitted, readCheckout, readJournal } from './file-checkout-journal.js';

let root: string;
let store: CanvasStore;
const source = '---\ngenerator: mkdocs\nsource: sites/example\n---\n# Website';
function bundle(files = [{ path: 'docs/index.md', encoding: 'utf8' as const, content: '# Website' }]) {
  return { format: 'symbi-website' as const, version: 1 as const, documentContent: source, files };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'symbi-package-boundary-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  store = new CanvasStore(root);
  await store.init();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['not json', 'null', '{}', '{"format":"symbi-website","version":2,"documentContent":"source","files":[]}',
  '{"format":"symbi-website","version":1,"documentContent":"source","files":null}'])('rejects malformed package %s', content => {
  expect(() => parseWebsite(content)).toThrow();
});
it.each(['../outside', '/absolute', 'docs\\outside.md', 'docs/./index.md', 'docs//index.md', ''])('rejects unsafe package file %s', name => {
  expect(() => parseWebsite(JSON.stringify(bundle([{ path: name, encoding: 'utf8', content: 'file' }])))).toThrow('safe relative');
});
it('rejects invalid fields, duplicate paths, invalid asset encodings and oversized file counts', () => {
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [null] }))).toThrow('Invalid website package file');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [{ path: 'image.png', encoding: 'base64', content: '!invalid' }] }))).toThrow('base64');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [bundle().files[0], bundle().files[0]] }))).toThrow('Duplicate');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: Array(501).fill(bundle().files[0]) }))).toThrow('package files');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [{ path: 'large.md', encoding: 'utf8', content: 'x'.repeat(999_900) }] }))).toThrow('limit');
});
it.each(['# Missing source', '---\nsource: /etc\n---', '---\nsource: sites/../outside\n---', '---\nsource: documents/site\n---'])('rejects invalid source config %s', async content => {
  await expect(exportWebsite(store, content)).rejects.toMatchObject({ status: 400 });
});
it('rejects missing and symbolic source folders and symbolic files while skipping dependency folders', async () => {
  await expect(exportWebsite(store, source)).rejects.toMatchObject({ status: 404 });
  await mkdir(path.join(root, 'external'));
  await mkdir(path.join(root, 'sites'), { recursive: true });
  await symlink(path.join(root, 'external'), path.join(root, 'sites/example'));
  await expect(exportWebsite(store, source)).rejects.toMatchObject({ status: 400 });
  await rm(path.join(root, 'sites/example'));
  await mkdir(path.join(root, 'sites/example/node_modules'), { recursive: true });
  await writeFile(path.join(root, 'sites/example/node_modules/ignored.js'), 'ignored');
  await symlink(path.join(root, 'external'), path.join(root, 'sites/example/link'));
  await expect(exportWebsite(store, source)).rejects.toThrow('symbolic links');
  await rm(path.join(root, 'sites/example/link'));
  expect(JSON.parse((await exportWebsite(store, source)).content).files).toEqual([]);
  await writeFile(path.join(root, 'regular-file'), 'not a directory');
  await expect(readWebsiteDirectory(path.join(root, 'regular-file'))).rejects.toMatchObject({ status: 400 });
});
it('creates an editable source package, retries safely, and preserves original files when a document save fails', async () => {
  const original = bundle();
  let saves = 0;
  await createWebsite(store, original, 'create-test', async () => { saves++; });
  await createWebsite(store, original, 'create-test', async () => { saves++; });
  expect(saves).toBe(2);
  await expect(createWebsite(store, original, 'other-creation', async () => undefined)).rejects.toMatchObject({ status: 409 });
  const next = bundle([{ path: 'docs/index.md', encoding: 'utf8', content: '# Edited' }]);
  await expect(replaceWebsite(store, source, next, packageHash(original.files), async () => { throw new Error('Document storage failed'); }, 'failed-upload'))
    .rejects.toThrow('Document storage failed');
  expect(await readFile(path.join(root, 'sites/example/docs/index.md'), 'utf8')).toBe('# Website');
  const moved = { ...next, documentContent: source.replace('sites/example', 'sites/moved') };
  await expect(replaceWebsite(store, source, moved, packageHash(original.files), async () => undefined, 'moved-folder')).rejects.toThrow('cannot move');
  await writeFile(path.join(root, 'sites/example/docs/index.md'), '# Outside edit');
  await expect(createWebsite(store, original, 'create-test', async () => undefined)).rejects.toThrow('changed source');
});
it('rejects corrupt and missing checkout journals and invalid revision identities', async () => {
  await expect(readCheckout(store, '../escape')).rejects.toMatchObject({ status: 400 });
  await expect(readCheckout(store, '12345678-1234-4234-8234-123456789abc')).rejects.toMatchObject({ status: 404 });
  const invalid = path.join(root, 'corrupt.json');
  await writeFile(invalid, 'invalid JSON');
  await expect(readJournal(invalid)).rejects.toThrow();
  await expect(operationCommitted(store, '../escape', 'bad-revision', 'operation')).rejects.toMatchObject({ status: 409 });
});

it('validates each package header and file field before writing any local source', () => {
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), documentContent: 42 }))).toThrow('Invalid symbi-website package');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [{ path: 42, encoding: 'utf8', content: 'x' }] }))).toThrow('package file');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [{ path: 'x', encoding: 'utf8', content: 42 }] }))).toThrow('package file');
  expect(() => parseWebsite(JSON.stringify({ ...bundle(), files: [{ path: 'x', encoding: 'hex', content: 'ab' }] }))).toThrow('package file');
});
it('bounds the exported package and rejects non-directory website source', async () => {
  await mkdir(path.join(root, 'sites/example'), { recursive: true });
  await writeFile(path.join(root, 'sites/example/large.md'), 'x'.repeat(999_901));
  await expect(exportWebsite(store, source)).rejects.toMatchObject({ status: 413 });
  await writeFile(path.join(root, 'sites/example/large.md'), 'x'.repeat(800_000));
  await expect(exportWebsite(store, source + 'x'.repeat(200_000))).rejects.toMatchObject({ status: 413 });
  await rm(path.join(root, 'sites/example'), { recursive: true });
  await writeFile(path.join(root, 'sites/example'), 'file');
  await expect(exportWebsite(store, source)).rejects.toMatchObject({ status: 400 });
});
it('completes an interrupted directory swap and restores a missing source folder before retry', async () => {
  const original = bundle();
  await createWebsite(store, original, 'seed-package', async () => undefined);
  const next = bundle([{ path: 'docs/index.md', encoding: 'utf8', content: '# Retry package' }]);
  const folder = path.join(root, 'sites/example');
  const fs = await import('node:fs/promises');
  await fs.rename(folder, folder + '.backup-retry-package');
  await expect(replaceWebsite(store, source, next, packageHash(original.files), async () => 'saved', 'retry-package')).resolves.toBe('saved');
  expect(await readFile(path.join(folder, 'docs/index.md'), 'utf8')).toBe('# Retry package');
  await fs.rename(folder, folder + '.backup-finished-package');
  await mkdir(path.join(folder, 'docs'), { recursive: true });
  await writeFile(path.join(folder, 'docs/index.md'), '# Retry package');
  await expect(replaceWebsite(store, source, next, packageHash(original.files), async () => 'recovered', 'finished-package')).resolves.toBe('recovered');
  await fs.rename(folder, folder + '.backup-outside-change');
  await mkdir(path.join(folder, 'docs'), { recursive: true });
  await writeFile(path.join(folder, 'docs/index.md'), '# Someone else changed this');
  await expect(replaceWebsite(store, source, next, packageHash(original.files), async () => undefined, 'outside-change')).rejects.toMatchObject({ status: 409 });
});
it('refuses a creation through symbolic parent folders', async () => {
  await mkdir(path.join(root, 'outside-folder'));
  await mkdir(path.join(root, 'sites'), { recursive: true });
  await symlink(path.join(root, 'outside-folder'), path.join(root, 'sites/link'));
  const linked = { ...bundle(), documentContent: source.replace('sites/example', 'sites/link/new-site') };
  await expect(createWebsite(store, linked, 'linked-create', async () => undefined)).rejects.toMatchObject({ status: 400 });
});
