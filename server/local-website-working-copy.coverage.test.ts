import type { PathLike } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadedFile, WorkingCopyManifest } from '../shared/working-copy.js';
import { packWebsiteWorkingCopy, unpackWebsiteWorkingCopy } from './local-website-working-copy.js';

// Inject one native rename failure (for example EXDEV on a cross-device move); every other call is real.
const fault = vi.hoisted(() => ({ source: undefined as RegExp | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: PathLike, to: PathLike) => {
    if (fault.source?.test(String(from))) {
      fault.source = undefined;
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
    }
    return actual.rename(from, to);
  } };
});

const roots: string[] = [];
afterEach(async () => { fault.source = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const documentContent = '---\nsource: sites/demo\ngenerator: mkdocs\n---\n# Demo';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'local-site-coverage-')); roots.push(root);
  const manifest = { kind: 'website', filename: 'demo.symbi-site.json', checkoutId: 'checkout', canvasId: 'canvas' } as WorkingCopyManifest;
  const downloaded: DownloadedFile = { manifest, filename: manifest.filename, content: JSON.stringify({ format: 'symbi-website', version: 1,
    documentContent, files: [{ path: 'docs/index.md', encoding: 'utf8', content: '# Original' }] }) };
  return { root, directory: path.join(root, 'project'), downloaded };
}

it('creates a missing target when overwrite is allowed', async () => {
  const setup = await fixture();
  const local = await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded, true);
  expect(await readFile(path.join(local.sourceDirectory, 'docs/index.md'), 'utf8')).toBe('# Original');
  expect(await readdir(setup.root)).toEqual(['project']);
});

it('refuses to overwrite a target that is a regular file and removes its staged download', async () => {
  const setup = await fixture();
  await writeFile(setup.directory, 'Keep this file');
  await expect(unpackWebsiteWorkingCopy(setup.directory, setup.downloaded, true)).rejects.toThrow('real directory');
  expect(await readFile(setup.directory, 'utf8')).toBe('Keep this file');
  expect(await readdir(setup.root)).toEqual(['project']);
});

it('restores the previous project when the staged download cannot be moved into place', async () => {
  const setup = await fixture();
  const local = await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded);
  await writeFile(path.join(local.sourceDirectory, 'docs/index.md'), '# Local edit');
  fault.source = /\.download-[0-9a-f-]+$/;
  await expect(unpackWebsiteWorkingCopy(setup.directory, setup.downloaded, true)).rejects.toMatchObject({ code: 'EXDEV' });
  expect(await readFile(path.join(local.sourceDirectory, 'docs/index.md'), 'utf8')).toBe('# Local edit');
  expect(await readdir(setup.root)).toEqual(['project']);
});

it('refuses symbolic-link control files and a project larger than the transport limit', async () => {
  const setup = await fixture();
  const local = await unpackWebsiteWorkingCopy(setup.directory, setup.downloaded);
  const manifest = await readFile(local.manifestPath, 'utf8');
  await writeFile(path.join(setup.root, 'manifest.json'), manifest);
  await rm(local.manifestPath);
  await symlink(path.join(setup.root, 'manifest.json'), local.manifestPath);
  await expect(packWebsiteWorkingCopy(setup.directory)).rejects.toThrow('regular files without symbolic links');
  await rm(local.manifestPath);
  await writeFile(local.manifestPath, manifest);
  await writeFile(local.documentPath, documentContent + '\n' + 'x'.repeat(1_000_000));
  await expect(packWebsiteWorkingCopy(setup.directory)).rejects.toThrow('exceeds the 999900-byte transport limit');
});
