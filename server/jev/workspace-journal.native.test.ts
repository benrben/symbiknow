import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import { readJournal } from './workspace-journal.js';

let root: string; const workspaceId = 'journal-proof';
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-journal-proof-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('replays durable deltas across instances, projects queue/progress, and detects a changed journal', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true });
  const original = emptyJevWorkspace(); await files.write(workspaceId, original);
  const base = await readFile(files.file(workspaceId), 'utf8');
  const state = await files.read(workspaceId); state.suppressions.push('retained');
  await files.write(workspaceId, state);
  expect(await readFile(files.file(workspaceId), 'utf8')).toBe(base);
  const other = new JevWorkspaceFiles(root);
  expect((await other.read(workspaceId)).suppressions).toEqual(['retained']);
  expect((await other.readProgress(workspaceId))?.revision).toBe(2);
  expect(await other.readQueued(workspaceId)).toEqual([]);
  const snapshot = await files.read(workspaceId);
  await writeFile(files.journalFile(workspaceId), `${await readFile(files.journalFile(workspaceId), 'utf8')}garbage`);
  await expect(files.assertUnchanged(workspaceId, snapshot)).rejects.toMatchObject({ status: 409 });
  const next = await files.read(workspaceId); next.suppressions.push('second');
  await files.write(workspaceId, next);
  expect((await other.read(workspaceId)).suppressions).toEqual(['retained', 'second']);
  expect((await readFile(files.journalFile(workspaceId), 'utf8')).endsWith('garbage')).toBe(false);
  expect((await stat(files.journalFile(workspaceId))).mode & 0o777).toBe(0o600);
});

it('compacts by atomic checkpoint and safely skips an older journal left after a crash', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true, journalCompactRecords: 2 });
  const first = emptyJevWorkspace(); await files.write(workspaceId, first);
  const second = await files.read(workspaceId); second.suppressions.push('one'); await files.write(workspaceId, second);
  const staleJournal = await readFile(files.journalFile(workspaceId));
  const third = await files.read(workspaceId); third.suppressions.push('two'); await files.write(workspaceId, third);
  await expect(stat(files.journalFile(workspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(files.journalFile(workspaceId), staleJournal);
  expect((await new JevWorkspaceFiles(root).read(workspaceId)).suppressions).toEqual(['one', 'two']);
  const continued = await files.read(workspaceId); continued.suppressions.push('three'); await files.write(workspaceId, continued);
  expect((await files.read(workspaceId)).suppressions).toEqual(['one', 'two', 'three']);
  expect((await stat(files.file(workspaceId))).mode & 0o777).toBe(0o600);
});

it('fails closed on a corrupt completed journal line and on an orphan journal', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true });
  await files.write(workspaceId, emptyJevWorkspace());
  const changed = await files.read(workspaceId); changed.suppressions.push('one'); await files.write(workspaceId, changed);
  const journal = await readFile(files.journalFile(workspaceId), 'utf8');
  await writeFile(files.journalFile(workspaceId), journal.replace('one', 'two'));
  await expect(files.read(workspaceId)).rejects.toMatchObject({ status: 503 });
  await rm(files.file(workspaceId));
  await expect(files.read(workspaceId)).rejects.toMatchObject({ status: 503 });
});

it('treats a missing journal as empty but propagates other filesystem read errors', async () => {
  await expect(readJournal(path.join(root, 'missing.journal'))).resolves.toEqual(Buffer.alloc(0));
  await expect(readJournal(root)).rejects.toMatchObject({ code: 'EISDIR' });
});
