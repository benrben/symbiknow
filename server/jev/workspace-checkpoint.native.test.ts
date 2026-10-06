import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-checkpoint-')); files = new JevWorkspaceFiles(root); await files.write('one', emptyJevWorkspace()); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('checks exact durable bytes while allowing uncommitted changes in its independent reader', async () => {
  const state = await files.read('one'); state.profiles.new = { role: 'specification' };
  await expect(files.assertUnchanged('one', state)).resolves.toBeUndefined();
  expect((await files.read('one')).profiles).toEqual({});
});
it('rejects an externally replaced checkpoint with the same byte length and restored timestamp', async () => {
  const state = await files.read('one'); const file = files.file('one'); const fixed = new Date('2026-10-05T00:00:00Z');
  await utimes(file, fixed, fixed); const bytes = await readFile(file, 'utf8');
  const replacement = bytes.replace('"revision":1', '"revision":2'); expect(replacement.length).toBe(bytes.length);
  await writeFile(`${file}.replacement`, replacement); await rename(`${file}.replacement`, file); await utimes(file, fixed, fixed);
  await expect(files.assertUnchanged('one', state)).rejects.toMatchObject({ status: 409 });
  expect((await files.read('one')).revision).toBe(2);
});
it('rejects a foreign or unavailable snapshot without accepting identical bytes from another workspace', async () => {
  await files.write('two', emptyJevWorkspace()); const state = await files.read('one');
  await expect(files.assertUnchanged('two', state)).rejects.toMatchObject({ status: 409 });
  await expect(files.assertUnchanged('one', emptyJevWorkspace())).rejects.toMatchObject({ status: 409 });
  const absent = await files.read('absent'); await expect(files.assertUnchanged('absent', absent)).rejects.toMatchObject({ status: 409 });
});
it('refuses a removed checkpoint and preserves unrelated native I/O failures', async () => {
  const state = await files.read('one'); await rm(files.file('one'));
  await expect(files.assertUnchanged('one', state)).rejects.toMatchObject({ status: 409 });
  await mkdir(files.file('one'));
  await expect(files.assertUnchanged('one', state)).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.read('one')).rejects.toMatchObject({ code: 'EISDIR' });
});

it('uses raw byte identity even when distinct bytes decode to the same UTF-8 replacement character', async () => {
  const raw = Buffer.from(JSON.stringify({ ...emptyJevWorkspace(), profiles: { source: { role: '?' } } }));
  const index = raw.indexOf('?'); raw[index] = 0xff; await writeFile(files.file('one'), raw);
  const state = await files.read('one'); expect(state.profiles.source.role).toBe('\ufffd');
  await expect(files.assertUnchanged('one', state)).resolves.toBeUndefined();
  raw[index] = 0xfe; await writeFile(files.file('one'), raw);
  expect((await files.read('one')).profiles.source.role).toBe('\ufffd');
  await expect(files.assertUnchanged('one', state)).rejects.toMatchObject({ status: 409 });
});
