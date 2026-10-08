import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DownloadedFile, WorkingCopyManifest } from '../shared/working-copy.js';
import { packWebsiteWorkingCopy, unpackWebsiteWorkingCopy } from './local-website-working-copy.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'local-site-project-')); roots.push(root);
  const documentContent = '---\nsource: sites/demo\ngenerator: mkdocs\n---\n# Demo';
  const manifest = { kind: 'website', filename: 'demo.symbi-site.json', checkoutId: 'checkout', canvasId: 'canvas' } as WorkingCopyManifest;
  const downloaded: DownloadedFile = { manifest, filename: manifest.filename, content: JSON.stringify({ format: 'symbi-website', version: 1,
    documentContent, files: [{ path: 'docs/index.md', encoding: 'utf8', content: '# Original' },
      { path: 'remove.md', encoding: 'utf8', content: 'Remove this' }, { path: 'logo.bin', encoding: 'base64', content: 'AAH/' }] }) };
  return { root, directory: path.join(root, 'project'), downloaded };
}
it('expands actual project files and repackages edits, additions, removals and binary assets', async () => {
  const setup = await fixture();
  const local = await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded);
  expect(await readFile(path.join(local.sourceDirectory, 'docs/index.md'), 'utf8')).toBe('# Original');
  expect(await readFile(path.join(local.sourceDirectory, 'logo.bin'))).toEqual(Buffer.from([0, 1, 255]));
  await writeFile(path.join(local.sourceDirectory, 'docs/index.md'), '# Edited locally');
  await writeFile(path.join(local.sourceDirectory, 'docs/new.md'), '# New');
  await rm(path.join(local.sourceDirectory, 'remove.md'));
  await writeFile(local.documentPath, '---\nsource: sites/demo\ngenerator: mkdocs\n---\n# Revised title');
  const packed = await packWebsiteWorkingCopy(setup.directory);
  const bundle = JSON.parse(packed.content);
  expect(bundle.documentContent).toContain('# Revised title');
  expect(bundle.files).toEqual([{ path: 'docs/index.md', encoding: 'utf8', content: '# Edited locally' },
    { path: 'docs/new.md', encoding: 'utf8', content: '# New' }, { path: 'logo.bin', encoding: 'base64', content: 'AAH/' }]);
  expect(packed.manifest).toEqual(setup.downloaded.manifest);
});
it('keeps edited directories until an explicit overwrite and refuses unsafe package paths or symlinks', async () => {
  const setup = await fixture();
  const local = await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded);
  const file = path.join(local.sourceDirectory, 'docs/index.md');
  await writeFile(file, '# Dirty local edit');
  await expect(unpackWebsiteWorkingCopy(setup.directory, setup.downloaded)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(file, 'utf8')).toBe('# Dirty local edit');
  await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded, true);
  expect(await readFile(file, 'utf8')).toBe('# Original');
  const invalid = JSON.parse(setup.downloaded.content); invalid.files[0].path = '../escape.md';
  await expect(unpackWebsiteWorkingCopy(path.join(setup.root, 'invalid'), { ...setup.downloaded, content: JSON.stringify(invalid) })).rejects.toThrow('safe relative');
  await symlink(setup.root, path.join(local.sourceDirectory, 'escape'));
  await expect(packWebsiteWorkingCopy(setup.directory)).rejects.toThrow('symbolic links');
});
it('refuses source and project symlink aliases and nonwebsite manifests', async () => {
  const setup = await fixture();
  await mkdir(setup.directory);
  await symlink(setup.directory, path.join(setup.root, 'alias'));
  await expect(packWebsiteWorkingCopy(path.join(setup.root, 'alias'))).rejects.toThrow('real directory');
  await writeFile(path.join(setup.directory, '.symbi.json'), JSON.stringify({ kind: 'markdown' }));
  await expect(packWebsiteWorkingCopy(setup.directory)).rejects.toThrow('does not describe a website');
});
