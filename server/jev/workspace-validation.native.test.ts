import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';
import { digest, journalRecord, replayWorkspaceJournal } from './workspace-journal.js';

let root: string;
const workspaceId = 'validation-proof';
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-validation-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function bytes(files: JevWorkspaceFiles) {
  return Promise.all([readFile(files.file(workspaceId)), readFile(files.journalFile(workspaceId))]);
}

it('rejects a correctly hashed journal that replays to a schema-invalid workspace without altering its bytes', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true });
  await files.write(workspaceId, emptyJevWorkspace());
  const checkpoint = await readFile(files.file(workspaceId));
  const base = await files.read(workspaceId);
  const invalid = { ...base, revision: base.revision + 1, jobs: 'invalid jobs table' } as unknown as JevWorkspaceState;
  const hash = digest(checkpoint);
  const entry = journalRecord(hash, hash, base, invalid);
  const journal = Buffer.from(`${JSON.stringify(entry)}\n`);
  await writeFile(files.journalFile(workspaceId), journal);
  // The journal is complete and its hash chain verifies; the recovered workspace schema is the rejected boundary.
  expect(replayWorkspaceJournal(base, hash, journal).state).toEqual(invalid);
  await expect(files.read(workspaceId)).rejects.toMatchObject({ status: 503, message: 'Symbi Reflex workspace journal requires recovery' });
  expect(await bytes(files)).toEqual([checkpoint, journal]);
});

it('rejects a stale same-revision write after another writer advances the journal and preserves the committed bytes', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true });
  await files.write(workspaceId, emptyJevWorkspace());
  const winner = await files.read(workspaceId);
  const stale = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(stale.revision).toBe(winner.revision);
  winner.suppressions.push('committed');
  await files.write(workspaceId, winner);
  const committed = await bytes(files);
  stale.suppressions.push('stale attempt');
  await expect(files.write(workspaceId, stale)).rejects.toMatchObject({ status: 409, message: 'The workspace checkpoint changed during completion' });
  expect(await bytes(files)).toEqual(committed);
  expect(await new JevWorkspaceFiles(root).read(workspaceId)).toEqual(winner);
});

it('replaces a journal-backed workspace with a legacy checkpoint and durably removes its nonempty journal', async () => {
  const files = new JevWorkspaceFiles(root, { journalWrites: true });
  await files.write(workspaceId, emptyJevWorkspace());
  const next = await files.read(workspaceId);
  next.suppressions.push('retained journal value');
  await files.write(workspaceId, next);
  const [oldCheckpoint, journal] = await bytes(files);
  expect(journal.length).toBeGreaterThan(0);
  const legacy = new JevWorkspaceFiles(root);
  const replacement = await legacy.read(workspaceId);
  replacement.suppressions.push('legacy checkpoint value');
  await legacy.write(workspaceId, replacement);
  expect(await readFile(files.file(workspaceId))).not.toEqual(oldCheckpoint);
  await expect(stat(files.journalFile(workspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
  const restarted = new JevWorkspaceFiles(root, { journalWrites: true });
  expect(await restarted.read(workspaceId)).toEqual(replacement);
  expect((await restarted.readProgress(workspaceId))?.revision).toBe(3);
  expect((await restarted.read(workspaceId)).suppressions).toEqual(['retained journal value', 'legacy checkpoint value']);
});
