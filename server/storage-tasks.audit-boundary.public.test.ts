import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-task-audit-boundary-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.createCanvas((await store.listWorkspaces())[0].id, { name: 'Audit boundaries' });
  const task = await store.createTask(canvas.id, { title: 'Durable task' }, 'Creator');
  const directory = path.join(root, 'tasks');
  return { root, store, canvas, task, tasks: path.join(directory, `${canvas.id}.json`),
    audit: path.join(directory, `${canvas.id}.audit.json`), log: path.join(directory, `${canvas.id}.audit.jsonl`),
    pending: path.join(directory, `${canvas.id}.pending.json`) };
}

const hash = (tasks: unknown) => createHash('sha256').update(JSON.stringify(tasks)).digest('hex');

it('normalizes a legacy audit event and refuses malformed audit arrays without changing the saved task', async () => {
  const f = await fixture();
  await rm(f.log);
  const legacy = { kind: 'deleted', actor: 'Prior reviewer', deletedAt: '2025-01-02T03:04:05.000Z', task: f.task };
  await writeFile(f.audit, JSON.stringify([legacy]));
  expect((await f.store.listTaskHistory(f.canvas.id, f.task.id)).items).toEqual([expect.objectContaining({
    eventId: 'legacy-0', taskId: f.task.id, at: legacy.deletedAt, before: f.task,
  })]);
  await writeFile(f.audit, JSON.stringify({ invalid: 'not an array' }));
  await expect(f.store.listTaskHistory(f.canvas.id, f.task.id)).rejects.toThrow('Invalid task audit history');
  expect((await f.store.listTasks(f.canvas.id))[0]).toEqual(f.task);
});

it('rejects malformed journal records and preserves the complete ordinary task snapshot for a corrected retry', async () => {
  const f = await fixture();
  const before = await readFile(f.tasks, 'utf8');
  for (const record of [{ type: 'events', events: 'not an array' }, { type: 'void' }, { type: 'unknown' }]) {
    await writeFile(f.log, `${JSON.stringify(record)}\n`);
    await expect(f.store.listTaskHistory(f.canvas.id, f.task.id)).rejects.toThrow('Invalid task audit journal');
  }
  await writeFile(f.log, '{"type":"events","events":[]}');
  await expect(f.store.listTaskHistory(f.canvas.id, f.task.id)).rejects.toThrow('Incomplete task audit journal');
  await writeFile(f.log, `${JSON.stringify({ type: 'events', events: [{ eventId: 'recovered', taskId: f.task.id,
    kind: 'created', actor: 'Recovery', after: f.task }] })}\n`);
  expect((await f.store.listTaskHistory(f.canvas.id, f.task.id)).items[0]).toMatchObject({ eventId: 'recovered' });
  expect(await readFile(f.tasks, 'utf8')).toBe(before);
});

it('rejects malformed pending transactions and divergent task snapshots before recovery can mutate them', async () => {
  const f = await fixture();
  const before = await readFile(f.tasks, 'utf8');
  for (const pending of [null, {}, { events: 'wrong' }, { events: [] },
    { events: [], beforeHash: 42, afterHash: 'hash' }, { events: [], before: [], after: 'wrong' }]) {
    await writeFile(f.pending, JSON.stringify(pending));
    const restarted = new CanvasStore(f.root);
    await expect(restarted.init()).rejects.toThrow('Invalid pending task transaction');
    expect(await readFile(f.tasks, 'utf8')).toBe(before);
  }
  await writeFile(f.pending, JSON.stringify({ events: [], beforeHash: hash([]), afterHash: hash([]) }));
  await expect(new CanvasStore(f.root).init()).rejects.toThrow('needs manual recovery');
  expect(await readFile(f.tasks, 'utf8')).toBe(before);
  await rm(f.pending);
  const recovered = new CanvasStore(f.root);
  await recovered.init();
  expect(await recovered.listTasks(f.canvas.id)).toEqual([f.task]);
});

it('rejects unreadable audit and pending paths instead of treating them as missing', async () => {
  const f = await fixture();
  await rm(f.audit, { force: true });
  await mkdir(f.audit);
  await expect(f.store.listTaskHistory(f.canvas.id, f.task.id)).rejects.toThrow();
  await rm(f.audit, { recursive: true });
  await mkdir(f.pending);
  await expect(new CanvasStore(f.root).init()).rejects.toThrow();
  expect((await f.store.listTasks(f.canvas.id))[0]).toEqual(f.task);
});

it('refuses stale guarded deletion and leaves the audit and source task intact', async () => {
  const f = await fixture();
  const beforeTask = await readFile(f.tasks, 'utf8');
  const beforeAudit = await readFile(f.log, 'utf8');
  await expect(f.store.deleteTask(f.canvas.id, f.task.id, 'Reviewer', (f.task.revision ?? 0) + 1))
    .rejects.toMatchObject({ status: 409 });
  expect(await readFile(f.tasks, 'utf8')).toBe(beforeTask);
  expect(await readFile(f.log, 'utf8')).toBe(beforeAudit);
  await f.store.deleteTask(f.canvas.id, f.task.id, 'Reviewer', f.task.revision);
  expect(await new CanvasStore(f.root).listTasks(f.canvas.id)).toEqual([]);
  expect((await new CanvasStore(f.root).listTaskHistory(f.canvas.id, f.task.id)).items[0])
    .toMatchObject({ kind: 'deleted', actor: 'Reviewer', before: f.task });
});

it('does not duplicate an audit event when a committed task snapshot is recovered', async () => {
  const f = await fixture();
  const event = (await f.store.listTaskHistory(f.canvas.id, f.task.id)).items[0];
  const beforeAudit = await readFile(f.log, 'utf8');
  await writeFile(f.pending, JSON.stringify({
    beforeHash: hash([]), afterHash: hash([f.task]), events: [event],
  }));

  const restarted = new CanvasStore(f.root);
  await restarted.init();
  expect(await restarted.listTasks(f.canvas.id)).toEqual([f.task]);
  expect((await restarted.listTaskHistory(f.canvas.id, f.task.id)).items).toEqual([event]);
  expect(await readFile(f.log, 'utf8')).toBe(beforeAudit);
  await expect(readFile(f.pending, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('restores a committed event when its audit journal was lost before recovery', async () => {
  const f = await fixture();
  const event = (await f.store.listTaskHistory(f.canvas.id, f.task.id)).items[0];
  await rm(f.log);
  await writeFile(f.pending, JSON.stringify({
    beforeHash: hash([]), afterHash: hash([f.task]), events: [event],
  }));

  const restarted = new CanvasStore(f.root);
  await restarted.init();
  expect(await restarted.listTasks(f.canvas.id)).toEqual([f.task]);
  expect((await restarted.listTaskHistory(f.canvas.id, f.task.id)).items).toEqual([event]);
  await expect(readFile(f.pending, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('discards a pending audit event when the task snapshot was never written', async () => {
  const f = await fixture();
  const event = { eventId: 'unwritten-update', kind: 'updated', actor: 'Reviewer', taskId: f.task.id,
    before: f.task, after: { ...f.task, title: 'Unwritten title', revision: (f.task.revision ?? 0) + 1 } };
  const beforeAudit = await readFile(f.log, 'utf8');
  await writeFile(f.pending, JSON.stringify({
    beforeHash: hash([f.task]), afterHash: hash([event.after]), events: [event],
  }));

  const restarted = new CanvasStore(f.root);
  await restarted.init();
  expect(await restarted.listTasks(f.canvas.id)).toEqual([f.task]);
  expect((await restarted.listTaskHistory(f.canvas.id, f.task.id)).items).toHaveLength(1);
  expect(await readFile(f.log, 'utf8')).toBe(beforeAudit);
  await expect(readFile(f.pending, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires an existing history event for Undo and durably reverses a task creation', async () => {
  const f = await fixture();
  const beforeTask = await readFile(f.tasks, 'utf8');
  const beforeAudit = await readFile(f.log, 'utf8');
  await expect(f.store.undoTask(f.canvas.id, f.task.id, 'missing-event', f.task.revision ?? 0, 'Reviewer'))
    .rejects.toMatchObject({ status: 404 });
  expect(await readFile(f.tasks, 'utf8')).toBe(beforeTask);
  expect(await readFile(f.log, 'utf8')).toBe(beforeAudit);

  const event = (await f.store.listTaskHistory(f.canvas.id, f.task.id)).items[0];
  await expect(f.store.undoTask(f.canvas.id, f.task.id, event.eventId!, f.task.revision ?? 0, 'Reviewer'))
    .resolves.toBeNull();
  const restarted = new CanvasStore(f.root);
  await restarted.init();
  expect(await restarted.listTasks(f.canvas.id)).toEqual([]);
  expect((await restarted.listTaskHistory(f.canvas.id, f.task.id)).items[0])
    .toMatchObject({ kind: 'deleted', actor: 'Reviewer', undoOf: event.eventId, before: f.task });
});

it('fails closed on an unreadable journal during recovery and history reads', async () => {
  const f = await fixture();
  const beforeTask = await readFile(f.tasks, 'utf8');
  await rm(f.log);
  await mkdir(f.log);
  await expect(f.store.listTaskHistory(f.canvas.id, f.task.id)).rejects.toThrow();
  await writeFile(f.pending, JSON.stringify({
    beforeHash: hash([]), afterHash: hash([f.task]), events: [],
  }));
  await expect(new CanvasStore(f.root).init()).rejects.toThrow();
  expect(await readFile(f.tasks, 'utf8')).toBe(beforeTask);
});

it('accepts a guarded delete of a legacy task without a revision and retains its audit history', async () => {
  const f = await fixture();
  const [legacyTask] = await f.store.listTasks(f.canvas.id);
  delete legacyTask.revision;
  await writeFile(f.tasks, JSON.stringify([legacyTask]));
  await f.store.deleteTask(f.canvas.id, legacyTask.id, 'Legacy reviewer', 0);
  expect(await f.store.listTasks(f.canvas.id)).toEqual([]);
  expect((await f.store.listTaskHistory(f.canvas.id, legacyTask.id)).items[0])
    .toMatchObject({ kind: 'deleted', actor: 'Legacy reviewer', before: legacyTask });
});

it('restores a legacy unversioned task through guarded Undo and assigns its first revision', async () => {
  const f = await fixture();
  const current = { ...f.task };
  delete current.revision;
  const before = { ...current, title: 'Original title' };
  await writeFile(f.tasks, JSON.stringify([current]));
  await writeFile(f.log, `${JSON.stringify({ type: 'events', events: [{
    eventId: 'legacy-update', kind: 'updated', actor: 'Prior reviewer', taskId: current.id, before, after: current,
  }] })}\n`);

  const restored = await f.store.undoTask(f.canvas.id, current.id, 'legacy-update', 0, 'Reviewer');
  expect(restored).toMatchObject({ title: 'Original title', revision: 1 });
  const restarted = new CanvasStore(f.root);
  await restarted.init();
  expect((await restarted.listTasks(f.canvas.id))[0]).toEqual(restored);
  expect((await restarted.listTaskHistory(f.canvas.id, current.id)).items[0])
    .toMatchObject({ kind: 'undone', actor: 'Reviewer', undoOf: 'legacy-update' });
});
