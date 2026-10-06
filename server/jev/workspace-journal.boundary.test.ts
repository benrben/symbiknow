import { expect, it } from 'vitest';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { emptyJevWorkspace } from './workspace.js';
import { applyWorkspacePatch, digest, journalRecord, replayWorkspaceJournal, workspacePatch,
  type WorkspacePatch } from './workspace-journal.js';

const baseHash = digest('isolated canonical checkpoint');
const recovery = { status: 503, message: 'Symbi Reflex workspace journal requires recovery' };
function state(patch: Record<string, unknown> = {}): JevWorkspaceState {
  return { ...emptyJevWorkspace(), ...patch } as JevWorkspaceState;
}
function signed(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify({ ...value, hash: digest(JSON.stringify(value)) })}\n`);
}
function unsigned(patch: unknown): Record<string, unknown> {
  return { format: 'jev-delta', version: 1, baseHash, fromRevision: 0, toRevision: 1,
    previousHash: baseHash, patch };
}
const emptyPatch = (): WorkspacePatch => ({ set: {}, remove: [], arrays: {}, objects: {} });

it('roundtrips changed keyed records, order, object fields and unknown future values through strict hash chaining', () => {
  const base = state();
  const first = state({ revision: 1, jobs: [{ id: 'a', state: 'queued' }, { id: 'b', state: 'queued' }],
    profiles: { a: { role: 'plan' }, b: { role: 'reference' } }, futureField: { retained: true } });
  const firstPatch = workspacePatch(base, first);
  expect(firstPatch.arrays.jobs).toMatchObject({ remove: [], upsert: { a: { id: 'a' }, b: { id: 'b' } } });
  expect(firstPatch.objects.profiles.set).toEqual(first.profiles);
  const one = journalRecord(baseHash, baseHash, base, first);
  const second = state({ revision: 2, jobs: [{ id: 'b', state: 'running' }, { id: 'a', state: 'queued' }],
    profiles: { b: { role: 'reference' }, c: { role: 'decision' } }, suppressions: ['retained'] });
  const secondPatch = workspacePatch(first, second);
  expect(secondPatch.arrays.jobs.order).toEqual(['b', 'a']);
  expect(secondPatch.objects.profiles).toEqual({ set: { c: { role: 'decision' } }, remove: ['a'] });
  expect(secondPatch.remove).toContain('futureField');
  const two = journalRecord(baseHash, one.hash, first, second);
  const bytes = Buffer.from(`${JSON.stringify(one)}\n${JSON.stringify(two)}\n`);
  expect(replayWorkspaceJournal(base, baseHash, bytes)).toEqual({ state: second, validBytes: bytes.length,
    records: 2, lastHash: two.hash });
});

it('fails closed on signed malformed keyed and profile deltas before touching canonical data', () => {
  const unsafe = Object.fromEntries([['__proto__', { id: '__proto__' }]]);
  const malformed: Array<[string, unknown]> = [
    ['missing patch', undefined], ['non-object patch', []], ['bad set', { ...emptyPatch(), set: [] }],
    ['bad remove', { ...emptyPatch(), remove: {} }], ['bad array table', { ...emptyPatch(), arrays: [] }],
    ['bad object table', { ...emptyPatch(), objects: [] }],
    ['revision set', { ...emptyPatch(), set: { revision: 9 } }],
    ['unsafe remove', { ...emptyPatch(), remove: ['constructor'] }],
    ['unknown keyed field', { ...emptyPatch(), arrays: { settings: { upsert: {}, remove: [] } } }],
    ['non-object keyed delta', { ...emptyPatch(), arrays: { jobs: null } }],
    ['bad keyed upsert', { ...emptyPatch(), arrays: { jobs: { upsert: [], remove: [] } } }],
    ['bad keyed remove', { ...emptyPatch(), arrays: { jobs: { upsert: {}, remove: {} } } }],
    ['non-string keyed removal', { ...emptyPatch(), arrays: { jobs: { upsert: {}, remove: [7] } } }],
    ['unsafe keyed upsert', { ...emptyPatch(), arrays: { jobs: { upsert: unsafe, remove: [] } } }],
    ['bad order type', { ...emptyPatch(), arrays: { jobs: { upsert: {}, remove: [], order: 3 } } }],
    ['bad order id', { ...emptyPatch(), arrays: { jobs: { upsert: {}, remove: [], order: [3] } } }],
    ['non-object keyed item', { ...emptyPatch(), arrays: { jobs: { upsert: { a: null }, remove: [] } } }],
    ['keyed item id mismatch', { ...emptyPatch(), arrays: { jobs: { upsert: { a: { id: 'b' } }, remove: [] } } }],
    ['unknown object field', { ...emptyPatch(), objects: { settings: { set: {}, remove: [] } } }],
    ['non-object profile delta', { ...emptyPatch(), objects: { profiles: null } }],
    ['bad profile set', { ...emptyPatch(), objects: { profiles: { set: [], remove: [] } } }],
    ['bad profile remove', { ...emptyPatch(), objects: { profiles: { set: {}, remove: {} } } }],
    ['non-string profile removal', { ...emptyPatch(), objects: { profiles: { set: {}, remove: [7] } } }],
    ['unsafe profile removal', { ...emptyPatch(), objects: { profiles: { set: {}, remove: ['__proto__'] } } }],
    ['unsafe profile set', { ...emptyPatch(), objects: { profiles: { set: unsafe, remove: [] } } }],
  ];
  const base = state();
  for (const [name, patch] of malformed) {
    expect(() => replayWorkspaceJournal(base, baseHash, signed(unsigned(patch))), name).toThrowError(recovery.message);
    expect(base).toEqual(emptyJevWorkspace());
  }
});

it('rejects malformed record metadata and invalid chain links, but ignores only an incomplete trailing line', () => {
  const base = state(); const after = state({ revision: 1, suppressions: ['one'] });
  const valid = journalRecord(baseHash, baseHash, base, after);
  for (const [name, field] of Object.entries({ format: 'wrong', version: 2, baseHash: 17,
    previousHash: null, fromRevision: 0.5, toRevision: 2.5 })) {
    const corrupted = { ...unsigned(valid.patch), [name]: field };
    expect(() => replayWorkspaceJournal(base, baseHash, signed(corrupted)), name).toThrowError(recovery.message);
  }
  expect(() => replayWorkspaceJournal(base, baseHash, Buffer.from(`${JSON.stringify({ ...valid, hash: 'wrong' })}\n`)))
    .toThrowError(recovery.message);
  expect(() => replayWorkspaceJournal(base, baseHash, Buffer.from('null\n'))).toThrowError(recovery.message);
  expect(() => replayWorkspaceJournal(base, baseHash, Buffer.from(`${JSON.stringify({ ...unsigned(valid.patch), hash: 9 })}\n`)))
    .toThrowError(recovery.message);
  const wrongLink = signed({ ...unsigned(valid.patch), previousHash: 'different' });
  expect(() => replayWorkspaceJournal(base, baseHash, wrongLink)).toThrowError(recovery.message);
  const complete = Buffer.from(`${JSON.stringify(valid)}\n`);
  const torn = Buffer.concat([complete, Buffer.from('{"format":"jev-delta"')]);
  expect(replayWorkspaceJournal(base, baseHash, torn)).toEqual({ state: after, validBytes: complete.length,
    records: 1, lastHash: valid.hash });
  expect(() => replayWorkspaceJournal(base, baseHash, Buffer.from('\n'))).toThrowError(recovery.message);
});

it('rejects missing, duplicate and unknown keyed order IDs during replay', () => {
  const base = state({ jobs: [{ id: 'a' }, { id: 'b' }] });
  const patch = emptyPatch(); patch.arrays.jobs = { upsert: {}, remove: [] };
  for (const order of [['a'], ['a', 'a'], ['a', 'missing']]) {
    patch.arrays.jobs.order = order;
    expect(() => applyWorkspacePatch(base, patch, 1)).toThrowError(recovery.message);
  }
  patch.arrays.jobs.order = ['b', 'a'];
  expect((applyWorkspacePatch(base, patch, 1).jobs as Array<{ id: string }>).map(job => job.id)).toEqual(['b', 'a']);
  delete patch.arrays.jobs.order;
  patch.arrays.jobs.remove = ['a'];
  patch.arrays.jobs.upsert = { c: { id: 'c' } };
  expect((applyWorkspacePatch(base, patch, 1).jobs as Array<{ id: string }>).map(job => job.id)).toEqual(['b', 'c']);
  expect((applyWorkspacePatch(state({ jobs: null }), patch, 1).jobs as Array<{ id: string }>).map(job => job.id)).toEqual(['c']);
});

it('falls back to atomic top-level values when keyed or profile source shapes are not patchable', () => {
  const before = state({ profiles: null, jobs: [{ id: 'duplicate' }, { id: 'duplicate' }],
    futureField: 'old' });
  const after = state({ revision: 1, profiles: { repaired: { role: 'reference' } },
    jobs: [{ id: 'single' }], futureField: 'new' });
  const patch = workspacePatch(before, after);
  expect(patch.objects).toEqual({}); expect(patch.arrays).toEqual({});
  expect(patch.set).toMatchObject({ profiles: after.profiles, jobs: after.jobs, futureField: 'new' });
  expect(applyWorkspacePatch(before, patch, 1)).toEqual(after);
});

it('applies an object delta after a legacy null profile value without changing the checkpoint', () => {
  const before = state({ profiles: null });
  const patch = emptyPatch(); patch.objects.profiles = { set: { reviewed: { role: 'decision' } }, remove: [] };
  const after = applyWorkspacePatch(before, patch, 1);
  expect(after.profiles).toEqual({ reviewed: { role: 'decision' } });
  expect(before.profiles).toBeNull();
});

it('removes a keyed record while preserving the remaining order', () => {
  const before = state({ jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const after = state({ revision: 1, jobs: [{ id: 'c' }, { id: 'a' }] });
  const patch = workspacePatch(before, after);
  expect(patch.arrays.jobs).toEqual({ upsert: {}, remove: ['b'], order: ['c', 'a'] });
  expect(applyWorkspacePatch(before, patch, 1)).toEqual(after);
});

it('rejects a delta that cannot reconstruct the exact signed checkpoint', () => {
  const before = state();
  const after = state({ revision: 1, profiles: Object.fromEntries([['__proto__', { role: 'unsafe' }]]) });
  expect(() => journalRecord(baseHash, baseHash, before, after))
    .toThrowError(expect.objectContaining({ status: 503, message: 'Symbi Reflex workspace delta could not be verified' }));
  expect(before.profiles).toEqual({});
});
