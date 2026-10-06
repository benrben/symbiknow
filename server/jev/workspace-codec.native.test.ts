import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevJson, JevSourceSnapshot } from '../../shared/jev-types.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-codec-')); files = new JevWorkspaceFiles(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'block',
  incarnation: 'original', sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-content-hash' };
function populated() {
  const state = emptyJevWorkspace(); state.profiles['canvas:block'] = { scopedSources: [source] as unknown as JevJson,
    exactQuote: '# Original source\nNo source bytes change.', manual: { $jevSourceVector: 0 } };
  return state;
}
async function replace(content: string) {
  const file = files.file('workspace'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, { mode: 0o600 });
}

it('reads legacy durable state and upgrades only its encoding on the next atomic private write', async () => {
  const state = populated(); state.revision = 7; await replace(JSON.stringify(state));
  const legacy = await files.read('workspace'); expect(legacy).toEqual(state);
  await files.write('workspace', legacy);
  expect(JSON.parse(await readFile(files.file('workspace'), 'utf8'))).toMatchObject({ codec: 'jev-source-vectors', version: 1 });
  expect(legacy.revision).toBe(8); expect(await new JevWorkspaceFiles(root).read('workspace')).toEqual(legacy);
  expect((await stat(files.file('workspace'))).mode & 0o777).toBe(0o600);
  expect(state.profiles['canvas:block'].scopedSources).toEqual([source]);
});

it('keeps the prior encoded ledger readable and removes partial temporary files after a real atomic replacement failure', async () => {
  const state = populated(); await files.write('workspace', state);
  const file = files.file('workspace'); const saved = await readFile(file, 'utf8'); const backup = file + '.backup';
  await rename(file, backup); await mkdir(file);
  const next = await new JevWorkspaceFiles(root).read('missing'); next.profiles = state.profiles;
  await expect(files.write('workspace', next)).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.read('workspace')).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await readFile(backup, 'utf8')).toBe(saved);
  expect((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await rm(file, { recursive: true }); await rename(backup, file);
  expect(await files.read('workspace')).toEqual(state);
});

it.each([
  ['invalid JSON', '{'],
  ['malformed state', JSON.stringify({ schemaVersion: 1 })],
  ['unsupported codec', JSON.stringify({ codec: 'jev-source-vectors', version: 99 })],
  ['dangling codec proof', JSON.stringify({ codec: 'jev-source-vectors', version: 1, sources: [source], vectors: [[9]], references: [], state: emptyJevWorkspace() })],
])('refuses %s on disk with a visible recovery error and preserves the file', async (_name, content) => {
  await replace(content); await expect(files.read('workspace')).rejects.toMatchObject({ status: 503 });
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(content);
});

it('checks settings and vocabulary after hydration and preserves ordinary missing-file and ID behavior', async () => {
  expect(await files.read('absent')).toEqual(emptyJevWorkspace());
  expect(() => files.file('../outside')).toThrowError(expect.objectContaining({ status: 400 }));
  const settings = populated(); settings.settings.people = [{ id: '', name: 'Incomplete', role: '' }];
  await files.write('workspace', settings);
  await expect(files.read('workspace')).rejects.toThrow('processing settings require recovery');
  const vocabulary = populated(); vocabulary.vocabulary = [{ id: 'invalid' }] as never;
  await files.write('workspace', vocabulary);
  await expect(files.read('workspace')).rejects.toThrow('vocabulary requires recovery');
});

it('serializes successful and failed state operations without poisoning the next durable codec write', async () => {
  const writes: number[] = [];
  const failed = files.serial('workspace', async () => { writes.push(1); throw new Error('failed operation'); });
  const written = files.serial('workspace', async () => { writes.push(2); await files.write('workspace', populated()); });
  await expect(failed).rejects.toThrow('failed operation'); await written;
  await files.serial('workspace', async () => { writes.push(3); expect((await files.read('workspace')).revision).toBe(1); });
  expect(writes).toEqual([1, 2, 3]);
});
