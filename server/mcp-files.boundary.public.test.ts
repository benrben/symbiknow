import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DownloadedFile, WorkingCopyManifest } from '../shared/working-copy.js';
import { CanvasApi } from './mcp-api.js';
import { downloadFile, uploadFile } from './mcp-files.js';

let root: string;
const manifest: WorkingCopyManifest = { version: 1, checkoutId: '12345678-1234-4234-8234-123456789abc', callerId: 'agent',
  workspaceId: 'workspace', canvasId: 'canvas', documentId: 'doc', incarnation: 'identity', branch: 'main', filename: 'doc.md',
  title: 'Document', kind: 'markdown', storageKind: 'markdown', baseContentHash: 'hash', baseRevision: 'a'.repeat(40), createdAt: new Date().toISOString() };
function api(download: DownloadedFile, uploads: Record<string, unknown>[] = []) {
  return new CanvasApi('http://files.example/api', (async (url, init) => {
    if (String(url).endsWith('/file-checkouts')) return Response.json(download);
    uploads.push(JSON.parse(String(init?.body)));
    return Response.json({ operationId: 'uploaded', revision: 'revision', status: 'saved', saved: true });
  }) as typeof fetch, () => ({}));
}
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'symbi-file-adapter-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('rejects nonregular and oversized decoded sources without blocking on a named pipe', async () => {
  const pipe = path.join(root, 'source.md');
  await promisify(execFile)('mkfifo', [pipe]);
  const client = api({ manifest, filename: manifest.filename, content: '# Source' });
  await expect(uploadFile(client, { mode: 'create', canvasId: 'canvas', sourcePath: pipe, idempotencyKey: 'pipe' })).rejects.toThrow('regular file');
  const invalidBytes = path.join(root, 'invalid.md');
  await writeFile(invalidBytes, Buffer.alloc(400_000, 255));
  await expect(uploadFile(client, { mode: 'create', canvasId: 'canvas', sourcePath: invalidBytes, idempotencyKey: 'decoded-size' })).rejects.toThrow('too large');
});
it('removes a reserved source after a sidecar collision and preserves an existing source on failure', async () => {
  const savedTo = path.join(root, 'saved.md');
  const sidecar = savedTo + '.symbi.json';
  await writeFile(sidecar, 'Existing manifest');
  const client = api({ manifest, filename: manifest.filename, content: '# New source' });
  await expect(downloadFile(client, { canvasId: 'canvas', blockId: 'doc', destinationPath: savedTo })).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(readFile(savedTo)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(sidecar, 'utf8')).toBe('Existing manifest');
  await rm(sidecar);
  await mkdir(sidecar);
  await writeFile(savedTo, '# Keep local edits');
  await expect(downloadFile(client, { canvasId: 'canvas', blockId: 'doc', destinationPath: savedTo, overwrite: true })).rejects.toThrow();
  expect(await readFile(savedTo, 'utf8')).toBe('# Keep local edits');
});
it('writes an absent overwrite destination and targets an explicit branch', async () => {
  const savedTo = path.join(root, 'draft.md');
  const client = api({ manifest, filename: manifest.filename, content: '# Draft' });
  const downloaded = await downloadFile(client, { canvasId: 'canvas', blockId: 'doc', branch: 'agent/draft', destinationPath: savedTo, overwrite: true });
  expect(downloaded.savedTo).toBe(savedTo);
  expect(await readFile(savedTo, 'utf8')).toBe('# Draft');
});
it('edits real website source files and packs them for explicit replace or create uploads', async () => {
  const website = { ...manifest, kind: 'website' as const, storageKind: 'website' as const, filename: 'doc.symbi-site.json' };
  const content = JSON.stringify({ format: 'symbi-website', version: 1,
    documentContent: '---\ngenerator: mkdocs\nsource: sites/example\n---', files: [{ path: 'docs/index.md', encoding: 'utf8', content: '# Original' }] });
  const uploads: Record<string, unknown>[] = [];
  const client = api({ manifest: website, filename: website.filename, content }, uploads);
  const directory = path.join(root, 'website');
  await downloadFile(client, { canvasId: 'canvas', blockId: 'doc', destinationPath: directory });
  await writeFile(path.join(directory, 'source/docs/index.md'), '# Edited source');
  await uploadFile(client, { mode: 'replace', canvasId: 'canvas', sourcePath: directory, idempotencyKey: 'website-local' });
  expect(uploads[0]).toMatchObject({ checkoutId: manifest.checkoutId, kind: 'website', filename: website.filename });
  expect(JSON.parse(String(uploads[0].content)).files[0].content).toBe('# Edited source');
  await expect(uploadFile(client, { mode: 'replace', canvasId: 'canvas', sourcePath: directory, content: 'both', idempotencyKey: 'ambiguous' })).rejects.toThrow('exactly one');
  await uploadFile(client, { mode: 'create', canvasId: 'canvas', sourcePath: directory, filename: 'new.json', kind: 'website', idempotencyKey: 'website-create' });
  expect(uploads[1]).not.toHaveProperty('checkoutId');
  await uploadFile(client, { mode: 'replace', canvasId: 'canvas', sourcePath: directory, checkoutId: manifest.checkoutId, idempotencyKey: 'explicit-checkout' });
  expect(uploads[2].checkoutId).toBe(manifest.checkoutId);
});
