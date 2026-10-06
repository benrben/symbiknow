import { expect, it } from 'vitest';
import { emptyJevWorkspace } from './workspace.js';
import { applyWorkspacePatch, digest, journalRecord, replayWorkspaceJournal, workspacePatch } from './workspace-journal.js';

it('round trips keyed changes, removal, order and nested profile fields without dropping history', () => {
  const before = emptyJevWorkspace();
  before.jobs = [{ id: 'a' }, { id: 'b' }] as never;
  before.profiles = { one: { role: 'note', custom: { exact: ['before'] } }, two: { role: 'reference' } };
  const after = structuredClone(before); after.revision = 1;
  after.jobs = [{ id: 'b' }, { id: 'a', state: 'completed' }, { id: 'c' }] as never;
  after.profiles = { one: { role: 'decision', custom: { exact: ['after'] } }, three: { role: 'task' } };
  const patch = workspacePatch(before, after);
  expect(patch.arrays.jobs.order).toEqual(['b', 'a', 'c']);
  expect(applyWorkspacePatch(before, patch, after.revision)).toEqual(after);
  expect(before.jobs).toEqual([{ id: 'a' }, { id: 'b' }]);
});

it('checks complete records, ignores a torn tail, and rejects a broken revision chain', () => {
  const base = emptyJevWorkspace(); const hash = digest(JSON.stringify(base));
  const next = structuredClone(base); next.revision = 1; next.suppressions.push('exact');
  const entry = journalRecord(hash, hash, base, next);
  const line = `${JSON.stringify(entry)}\n`;
  const replay = replayWorkspaceJournal(base, hash, Buffer.from(`${line}{"torn":`));
  expect(replay.state).toEqual(next); expect(replay.validBytes).toBe(Buffer.byteLength(line));
  expect(() => replayWorkspaceJournal(base, hash, Buffer.from(`${line.replace('exact', 'wrong')}\n`)))
    .toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => replayWorkspaceJournal(base, hash, Buffer.from(`${line}${line}`)))
    .toThrowError(expect.objectContaining({ status: 503 }));
});
