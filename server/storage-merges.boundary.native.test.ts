import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import type { CanvasTask } from '../shared/types.js';

it('retains native failed-merge recovery on unreadable or corrupted tasks and migrates legacy journal revisions on retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-merge-boundary-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Merge recovery' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const taskDirectory = path.join(root, 'tasks');
  const tasksFile = path.join(taskDirectory, canvas.id + '.json');
  const keeper = await store.createBlock(canvas.id, { title: 'Keeper', content: '# Keeper' });
  const folded = await store.createBlock(canvas.id, { title: 'Folded', content: '# Folded' });
  const hook = path.join(root, '.versions', keeper.id, '.git', 'hooks', 'post-commit');
  try {
    await store.createTask(canvas.id, { title: 'Legacy task', blockIds: [folded.id] }, 'Creator');
    const legacy = await store.listTasks(canvas.id); delete legacy[0].revision;
    await writeFile(tasksFile, JSON.stringify(legacy));
    const input = { keepBlockId: keeper.id, mergeBlockIds: [folded.id], content: '# Combined',
      expectedContentHashes: { [keeper.id]: keeper.contentHash, [folded.id]: folded.contentHash } };
    await writeFile(hook, '#!/usr/bin/env node\nconst fs=require("node:fs");\n' +
      `fs.chmodSync(${JSON.stringify(tasksFile)},0);fs.chmodSync(${JSON.stringify(taskDirectory)},0);\n`, { mode: 0o755 });
    await expect(store.mergeDocuments(canvas.id, input)).rejects.toMatchObject({ name: 'AggregateError',
      errors: [expect.objectContaining({ code: 'EACCES' }), expect.objectContaining({ code: 'EACCES' })] });
    await chmod(taskDirectory, 0o755); await chmod(tasksFile, 0o644); await rm(hook);
    const directory = path.join(root, 'jev-merges');
    const [name] = await readdir(directory);
    await new CanvasStore(root).undoMerge(name.slice(0, -5));
    const validBefore = await readFile(tasksFile, 'utf8');
    await writeFile(hook, '#!/usr/bin/env node\nconst fs=require("node:fs");\n' +
      `fs.writeFileSync(${JSON.stringify(tasksFile)},"{ damaged during merge");fs.chmodSync(${JSON.stringify(taskDirectory)},0o555);\n`, { mode: 0o755 });
    await expect(store.mergeDocuments(canvas.id, input)).rejects.toMatchObject({ name: 'AggregateError',
      errors: [expect.objectContaining({ code: 'EACCES' }), expect.any(SyntaxError)] });
    await chmod(taskDirectory, 0o755); await rm(hook); await writeFile(tasksFile, validBefore);
    const damaged = (await readdir(directory)).find(file => file !== name)!;
    await new CanvasStore(root).undoMerge(damaged.slice(0, -5));
    const restored = await store.getCanvas(canvas.id, true);
    const next = await store.mergeDocuments(canvas.id, { ...input, expectedContentHashes: Object.fromEntries(restored.blocks.map(block => [block.id, block.contentHash])) });
    const journalFile = path.join(directory, next.mergeId + '.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    delete journal.recoveryCanvases;
    (journal.afterTasks as CanvasTask[]).forEach(task => { delete task.revision; });
    await writeFile(journalFile, JSON.stringify(journal));
    await writeFile(tasksFile, JSON.stringify(journal.afterTasks));
    expect(await new CanvasStore(root).undoMerge(next.mergeId)).toEqual({ mergeId: next.mergeId, reverted: true });
    expect((await store.listTasks(canvas.id))[0]).toMatchObject({ blockIds: [folded.id], revision: 1 });
    expect((await store.getCanvasBlock(canvas.id, keeper.id)).content).toBe(keeper.content);
    expect((await store.getCanvasBlock(canvas.id, folded.id)).archived).not.toBe(true);
  } finally {
    await chmod(taskDirectory, 0o755); await chmod(tasksFile, 0o644);
    await rm(root, { recursive: true, force: true });
  }
});
