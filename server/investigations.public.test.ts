import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { InvestigationStore } from './investigations.js';

const execute = promisify(execFile);
const input = { workspaceId: 'acme-team', title: 'Native investigation', visibility: 'shared' } as const;
let root: string;
let store: CanvasStore;
let investigations: InvestigationStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'allteam-native-investigations-'));
  store = new CanvasStore(root);
  await store.init();
  investigations = new InvestigationStore(store);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function recordFile(id: string) { return path.join(root, 'investigations', `${id}.json`); }

it('ignores explicitly undefined optional update fields instead of persisting an unreadable investigation', async () => {
  const messages = [{ role: 'user', content: 'Retain this conversation.' }];
  const created = await investigations.create({ ...input, visibility: 'private', messages });
  const updated = await investigations.update(created.investigation.id, { expectedRevision: 1,
    title: undefined, visibility: undefined, messages: undefined }, created.accessKey);
  expect(updated.investigation).toMatchObject({ title: input.title, visibility: 'private', messages, revision: 2 });
  const restarted = new InvestigationStore(new CanvasStore(root));
  expect(await restarted.get(created.investigation.id, created.accessKey)).toEqual(updated.investigation);
  expect((await stat(recordFile(created.investigation.id))).mode & 0o777).toBe(0o600);
});

it('preserves saved messages and references when a partial update changes only the title', async () => {
  const messages = [{ role: 'user', content: 'Retain this conversation.' }];
  const sourceRefs = [{ canvasId: 'product-roadmap', blockId: 'launch-checklist' }];
  const proposalRefs = [{ kind: 'chat', id: 'proposal-1' }];
  const created = await investigations.create({ ...input, messages, sourceRefs, proposalRefs });
  const updated = await investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Renamed investigation' });
  expect(updated.investigation).toMatchObject({ messages, sourceRefs, proposalRefs, title: 'Renamed investigation' });
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id)).toEqual(updated.investigation);
});

it('serializes updates made through absolute and relative paths to the same persisted record', async () => {
  const created = await investigations.create(input);
  const relative = new InvestigationStore(new CanvasStore(path.relative(process.cwd(), root)));
  const attempts = await Promise.allSettled([
    investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Absolute update' }),
    relative.update(created.investigation.id, { expectedRevision: 1, title: 'Relative update' }),
  ]);
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.find(attempt => attempt.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  expect((await investigations.get(created.investigation.id)).revision).toBe(2);
});

it('serializes updates made through a real filesystem alias and can continue after a queued conflict', async () => {
  const created = await investigations.create(input);
  const alias = path.join(root, 'store-alias');
  await symlink(root, alias, 'dir');
  const aliased = new InvestigationStore(new CanvasStore(alias));
  const attempts = await Promise.allSettled([
    investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Original update' }),
    aliased.update(created.investigation.id, { expectedRevision: 1, title: 'Aliased update' }),
  ]);
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.find(attempt => attempt.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  const next = await aliased.update(created.investigation.id, { expectedRevision: 2, title: 'After conflict' });
  expect(await investigations.get(created.investigation.id)).toEqual(next.investigation);
});

it('removes an incomplete temporary write after a real destination obstruction and preserves the record for a later retry', async () => {
  const created = await investigations.create(input);
  const file = recordFile(created.investigation.id);
  const original = await readFile(file, 'utf8');
  const workspacesFile = path.join(root, 'workspaces.json');
  const workspaceData = await readFile(workspacesFile, 'utf8');
  await rename(workspacesFile, workspacesFile + '.backup');
  await execute('mkfifo', [workspacesFile]);
  const update = investigations.update(created.investigation.id, { expectedRevision: 1, canvasId: 'product-roadmap', title: 'Blocked update' });
  const rejected = expect(update).rejects.toMatchObject({ code: 'EISDIR' });
  // Opening the native FIFO writer waits until workspace validation has reached
  // its filesystem read, after the investigation's original revision was read.
  const writer = await open(workspacesFile, 'w');
  await rename(file, file + '.backup');
  await mkdir(file);
  await writer.writeFile(workspaceData);
  await writer.close();
  await rejected;
  expect(await readdir(path.dirname(file))).toEqual(expect.arrayContaining([path.basename(file), path.basename(file) + '.backup']));
  expect((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await rm(file, { recursive: true });
  await rename(file + '.backup', file);
  await rm(workspacesFile);
  await rename(workspacesFile + '.backup', workspacesFile);
  expect(await readFile(file, 'utf8')).toBe(original);
  const updated = await investigations.update(created.investigation.id, { expectedRevision: 1, canvasId: 'product-roadmap', title: 'Retried update' });
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id)).toEqual(updated.investigation);
});

it('returns an empty list for a new workspace and preserves not-found and invalid-input errors without creating records', async () => {
  expect(await investigations.list({ workspaceId: input.workspaceId })).toEqual({ investigations: [] });
  await expect(investigations.get('missing')).rejects.toMatchObject({ status: 404 });
  await expect(investigations.update('missing', { expectedRevision: 1, title: 'Missing' })).rejects.toMatchObject({ status: 404 });
  await expect(investigations.delete('missing')).rejects.toMatchObject({ status: 404 });
  await expect(investigations.create({ ...input, workspaceId: 'missing' })).rejects.toMatchObject({ status: 404 });
  await expect(investigations.list({ workspaceId: 'missing' })).rejects.toMatchObject({ status: 404 });
  await expect(investigations.update('../escape', { expectedRevision: 1, title: 'Invalid ID' })).rejects.toMatchObject({ status: 400 });
  await expect(investigations.delete('../escape')).rejects.toMatchObject({ status: 400 });
  await expect(investigations.list({ workspaceId: input.workspaceId, privateKeys: [''] })).rejects.toMatchObject({ status: 400 });
  expect(await readdir(root)).not.toContain('investigations');
});

it('surfaces native read, list, write and queue-path obstructions and can retry after repairing them', async () => {
  const created = await investigations.create(input);
  const file = recordFile(created.investigation.id);
  await rename(file, file + '.backup');
  await mkdir(file);
  await expect(investigations.get(created.investigation.id)).rejects.toMatchObject({ code: 'EISDIR' });
  await rm(file, { recursive: true });
  await rename(file + '.backup', file);
  expect(await investigations.get(created.investigation.id)).toEqual(created.investigation);
  const records = path.dirname(file);
  await rename(records, records + '.backup');
  await writeFile(records, 'directory obstruction');
  await expect(investigations.list({ workspaceId: input.workspaceId })).rejects.toMatchObject({ code: 'ENOTDIR' });
  await expect(investigations.create(input)).rejects.toMatchObject({ code: 'EEXIST' });
  await rm(records);
  await rename(records + '.backup', records);
  const blockedRoot = path.join(root, 'blocked-root');
  await writeFile(blockedRoot, 'root obstruction');
  const blocked = new InvestigationStore(new CanvasStore(blockedRoot));
  await expect(blocked.update(created.investigation.id, { expectedRevision: 1, title: 'Blocked' })).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect(await investigations.get(created.investigation.id)).toEqual(created.investigation);
  expect((await investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Repaired' })).investigation.title).toBe('Repaired');
});

it('rejects malformed persistence, mismatched IDs and missing private hashes without exposing or rewriting the record, then reopens after repair', async () => {
  const created = await investigations.create({ ...input, visibility: 'private' });
  const file = recordFile(created.investigation.id);
  const original = await readFile(file, 'utf8');
  const saved = JSON.parse(original) as Record<string, unknown>;
  const malformed = ['{', JSON.stringify({ ...saved, id: 'other-record' }),
    JSON.stringify({ ...saved, keyHash: undefined }), JSON.stringify({ ...saved, revision: 0 })];
  for (const raw of malformed) {
    await writeFile(file, raw);
    await expect(investigations.get(created.investigation.id, created.accessKey)).rejects.toMatchObject({ status: 500, message: 'Saved investigation is invalid' });
    await expect(investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Invalid save' }, created.accessKey))
      .rejects.toMatchObject({ status: 500 });
    expect(await readFile(file, 'utf8')).toBe(raw);
  }
  await writeFile(file, original);
  expect(await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id, created.accessKey)).toEqual(created.investigation);
});

it('lists only authorized records in the requested workspace, skips temporary files, and orders summaries by persisted update time', async () => {
  const oldest = await investigations.create({ ...input, canvasId: 'product-roadmap', question: 'Why?',
    messages: [{ role: 'user', content: 'Question' }], sourceRefs: [{ canvasId: 'product-roadmap', blockId: 'launch-checklist' }],
    proposalRefs: [{ kind: 'jev', id: 'proposal-1' }] });
  const recent = await investigations.create({ ...input, title: 'Recent investigation', question: '' });
  const privateRecord = await investigations.create({ ...input, visibility: 'private' });
  const otherWorkspace = await store.createWorkspace({ name: 'Other workspace' });
  await investigations.create({ ...input, workspaceId: otherWorkspace.id });
  const saved = JSON.parse(await readFile(recordFile(oldest.investigation.id), 'utf8'));
  await writeFile(recordFile(oldest.investigation.id), JSON.stringify({ ...saved, updatedAt: '2020-01-01T00:00:00.000Z' }));
  await writeFile(path.join(root, 'investigations', 'incomplete.json.tmp'), '{');
  await writeFile(path.join(root, 'investigations', 'notes.txt'), 'unrelated');
  const visible = (await investigations.list({ workspaceId: input.workspaceId, privateKeys: ['wrong-key'] })).investigations;
  expect(visible.map(record => record.id)).toEqual([recent.investigation.id, oldest.investigation.id]);
  expect(visible[0]).not.toHaveProperty('canvasId');
  expect(visible[0]).not.toHaveProperty('question');
  expect(visible[1]).toMatchObject({ canvasId: 'product-roadmap', question: 'Why?', messageCount: 1, sourceCount: 1, proposalCount: 1 });
  expect(visible[1]).not.toHaveProperty('messages');
  const authorized = await investigations.list({ workspaceId: input.workspaceId, privateKeys: ['wrong-key', privateRecord.accessKey] });
  expect(authorized.investigations).toHaveLength(3);
  expect(authorized.investigations.map(record => record.id)).toContain(privateRecord.investigation.id);
});

it('continues processing queued revision changes after a failed update without losing the successful saved state', async () => {
  const created = await investigations.create(input);
  const attempts = await Promise.allSettled([
    investigations.update(created.investigation.id, { expectedRevision: 9, title: 'Stale save' }),
    investigations.update(created.investigation.id, { expectedRevision: 1, title: 'Queued successful save' }),
    investigations.update(created.investigation.id, { expectedRevision: 9, title: 'Another stale save' }),
  ]);
  expect(attempts[0]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  expect(attempts[1]).toMatchObject({ status: 'fulfilled', value: { investigation: { title: 'Queued successful save', revision: 2 } } });
  expect(attempts[2]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  const reloaded = await new InvestigationStore(new CanvasStore(root)).get(created.investigation.id);
  expect(reloaded).toMatchObject({ title: 'Queued successful save', revision: 2 });
  expect((await investigations.update(created.investigation.id, { expectedRevision: 2, title: 'Retry after conflict' })).investigation.revision).toBe(3);
});

it('rejects unserializable native research changes before changing a saved investigation', async () => {
  const created = await investigations.create(input);
  const file = recordFile(created.investigation.id);
  const original = await readFile(file, 'utf8');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const researchSnapshot of [Symbol('unsupported research'), 1n, circular]) {
    await expect(investigations.update(created.investigation.id, { expectedRevision: 1, researchSnapshot })).rejects.toMatchObject({ status: 400 });
    expect(await readFile(file, 'utf8')).toBe(original);
  }
  expect(await investigations.get(created.investigation.id)).toEqual(created.investigation);
});
