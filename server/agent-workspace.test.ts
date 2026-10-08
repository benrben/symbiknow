import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeDownload, workspacePath, workingManifest, workingUpload } from './agent-workspace.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-')); roots.push(root); return root; }
const downloaded = { content: '# Source', manifest: { checkoutId: 'checkout', filename: 'source.md', canvasId: 'foreign-canvas', kind: 'markdown' } };
it('preserves existing source and rolls back empty reservation when a sidecar collides', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'source.md.symbi.json'), 'existing manifest');
  await expect(materializeDownload(root, downloaded, 'source.md')).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(readFile(path.join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(root, 'source.md'), '# Local edits');
  await expect(materializeDownload(root, downloaded, 'source.md')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe('# Local edits');
  await materializeDownload(root, downloaded, 'source.md', true);
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe('# Source');
});
it('keeps a foreign working-copy destination and generates stable retry keys', async () => {
  const root = await directory();
  await materializeDownload(root, downloaded, 'source.md');
  const first = await workingUpload(root, { sourcePath: '/source.md' }, 'active-canvas');
  expect(first).toMatchObject({ canvasId: 'foreign-canvas', checkoutId: 'checkout', mode: 'replace', content: '# Source' });
  expect(await workingUpload(root, { sourcePath: '/source.md' }, 'active-canvas')).toEqual(first);
  await writeFile(path.join(root, 'source.md'), '# Changed');
  expect((await workingUpload(root, { sourcePath: '/source.md' }, 'active-canvas')).idempotencyKey).not.toBe(first.idempotencyKey);
});
it('rejects traversal and symlinks outside the workspace', async () => {
  const root = await directory(); const outside = await directory();
  await symlink(outside, path.join(root, 'alias'));
  await expect(workspacePath(root, '../escape')).rejects.toThrow('inside the conversation');
  await expect(workspacePath(root, '.')).rejects.toThrow('outside the conversation');
  await expect(workspacePath(root, '/alias/file.md')).rejects.toThrow('symbolic links');
});
it('preserves an edited source when explicit overwrite cannot reserve its sidecar', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'source.md'), '# Keep local edits');
  await mkdir(path.join(root, 'source.md.symbi.json'));
  await expect(materializeDownload(root, downloaded, 'source.md', true)).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await readFile(path.join(root, 'source.md'), 'utf8')).toBe('# Keep local edits');
});
it('does not materialize incomplete transfers and retains the transfer filename and active canvas fallback', async () => {
  const root = await directory();
  for (const output of [{ content: '# Missing manifest' }, { manifest: downloaded.manifest, content: null }])
    expect(await materializeDownload(root, output)).toBe(output);
  const output = { content: '# Source', filename: 'fallback.md', manifest: { checkoutId: 'checkout', kind: 'markdown' } };
  const saved = await materializeDownload(root, output);
  expect(saved).toMatchObject({ savedTo: '/checkout/fallback.md' });
  expect(await workingUpload(root, { sourcePath: '/checkout/fallback.md' }, 'active-canvas'))
    .toMatchObject({ canvasId: 'active-canvas', filename: 'fallback.md' });
});
it('reads expanded-project manifests and distinguishes absent metadata from unreadable metadata', async () => {
  const root = await directory(); const project = path.join(root, 'project');
  await mkdir(project); await writeFile(path.join(project, '.symbi.json'), JSON.stringify({ checkoutId: 'website-checkout', kind: 'website' }));
  expect(await workingManifest(root, '/project')).toEqual({ checkoutId: 'website-checkout', kind: 'website' });
  await writeFile(path.join(root, 'source.md'), '# Source');
  expect(await workingManifest(root, '/source.md')).toBeNull();
  await writeFile(path.join(root, 'source.md.symbi.json'), '{broken');
  await expect(workingManifest(root, '/source.md')).rejects.toBeInstanceOf(SyntaxError);
});
it('requires explicit creation for fresh local files and never reads symlinked manifests', async () => {
  const root = await directory(); const outside = await directory();
  await writeFile(path.join(root, 'new.md'), '# New local document');
  await expect(workingUpload(root, { sourcePath: '/new.md' }, 'canvas')).rejects.toThrow('explicit mode=create');
  expect(await workingUpload(root, { sourcePath: '/new.md', mode: 'create' }, 'canvas')).toMatchObject({ mode: 'create', canvasId: 'canvas', content: '# New local document' });
  await writeFile(path.join(outside, 'manifest.json'), '{}');
  await symlink(path.join(outside, 'manifest.json'), path.join(root, 'new.md.symbi.json'));
  await expect(workingUpload(root, { sourcePath: '/new.md', mode: 'create' }, 'canvas')).rejects.toThrow('symbolic links');
});
it('retains explicit upload metadata and retry keys while creation drops downloaded identity defaults', async () => {
  const root = await directory(); await materializeDownload(root, downloaded, 'source.md');
  expect(await workingUpload(root, { sourcePath: '/source.md', mode: 'propose', canvasId: 'chosen-canvas',
    checkoutId: 'chosen-checkout', filename: 'chosen.mdx', kind: 'mdx', idempotencyKey: 'retry-key', title: 'Chosen title' }, 'active-canvas'))
    .toEqual({ mode: 'propose', canvasId: 'chosen-canvas', checkoutId: 'chosen-checkout', filename: 'chosen.mdx', kind: 'mdx',
      idempotencyKey: 'retry-key', title: 'Chosen title', content: '# Source' });
  expect(await workingUpload(root, { sourcePath: '/source.md', mode: 'create' }, 'active-canvas'))
    .toMatchObject({ canvasId: 'active-canvas', checkoutId: undefined, filename: 'source.md', kind: 'markdown', content: '# Source' });
});
it('rejects direct content, missing local paths and malformed local sidecars before producing an upload', async () => {
  const root = await directory();
  await expect(workingUpload(root, {})).rejects.toThrow('requires sourcePath');
  await expect(workingUpload(root, { sourcePath: '/source.md', content: '# Replacement' })).rejects.toThrow('do not provide replacement content');
  await expect(workingUpload(root, { sourcePath: '/source.md', mode: 'create' })).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(root, 'source.md'), '# Local source');
  await writeFile(path.join(root, 'source.md.symbi.json'), '{invalid');
  await expect(workingUpload(root, { sourcePath: '/source.md', mode: 'create' })).rejects.toBeInstanceOf(SyntaxError);
});
it('rejects oversized and nonregular working files before reading their contents', async () => {
  const root = await directory(); const source = await open(path.join(root, 'large.md'), 'w');
  try { await source.truncate(3_999_601); } finally { await source.close(); }
  await expect(workingUpload(root, { sourcePath: '/large.md', mode: 'create' })).rejects.toThrow('upload size limit');
  execFileSync('mkfifo', [path.join(root, 'pipe.md')]);
  await expect(workingUpload(root, { sourcePath: '/pipe.md', mode: 'create' })).rejects.toThrow('regular working file');
});
