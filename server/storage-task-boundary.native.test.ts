import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { blockStateHash } from './block-state.js';
import { patchedTask } from './coordination.js';
import type { CanvasTask } from '../shared/types.js';

it('versions persisted legacy tasks independently across claim, comment, reviewed edit and dependency deletion, and clears typed links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-legacy-task-boundary-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Legacy task migration' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Tasks and evidence' });
  try {
    const source = await store.createBlock(canvas.id, { title: 'Evidence', content: '# Exact source bytes' });
    const firstLink = await store.createBlock(canvas.id, { title: 'First relation' });
    const secondLink = await store.createBlock(canvas.id, { title: 'Second relation' });
    const linked = await store.updateBlock(canvas.id, source.id, { links: [firstLink.id, secondLink.id],
      linkTypes: { [secondLink.id]: 'related', [firstLink.id]: 'prerequisite' } });
    expect(blockStateHash(linked)).toBe(blockStateHash({ ...linked, linkTypes: { [firstLink.id]: 'prerequisite', [secondLink.id]: 'related' } }));
    const claimed = await store.createTask(canvas.id, { title: 'Claim legacy' }, 'Creator');
    const commented = await store.createTask(canvas.id, { title: 'Comment legacy' }, 'Creator');
    const prerequisite = await store.createTask(canvas.id, { title: 'Delete prerequisite' }, 'Creator');
    const dependent = await store.createTask(canvas.id, { title: 'Dependent legacy', dependsOnTaskIds: [prerequisite.id] }, 'Creator');
    const reviewed = await store.createTask(canvas.id, { title: 'Reviewed legacy' }, 'Creator');
    const file = path.join(root, 'tasks', canvas.id + '.json');
    const legacy = await store.listTasks(canvas.id); legacy.forEach(task => { delete task.revision; });
    await writeFile(file, JSON.stringify(legacy));
    const before = await readFile(file, 'utf8');
    expect(patchedTask(legacy.find(task => task.id === reviewed.id)!, { title: 'Current edit' }, 'Reviewer', new Set()))
      .toMatchObject({ revision: 1, title: 'Current edit' });
    await expect(store.updateTask(canvas.id, reviewed.id, { title: 'Stale edit', expectedRevision: 1 }, 'Reviewer'))
      .rejects.toMatchObject({ status: 409, message: 'The task changed since this suggestion was reviewed' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await store.claimTask(canvas.id, claimed.id, 'Owner', false)).toMatchObject({ revision: 1, assignee: 'Owner' });
    expect(await store.commentTask(canvas.id, commented.id, 'Exact review note', 'Reviewer')).toMatchObject({ revision: 1, comments: [{ text: 'Exact review note' }] });
    const finding = { id: 'native-finding', title: 'Review exact source', canvasId: canvas.id, blockIds: [source.id] };
    expect(await store.updateTask(canvas.id, reviewed.id, { title: 'Current edit', expectedRevision: 0, findingRef: finding }, 'Reviewer'))
      .toMatchObject({ revision: 1, title: 'Current edit', findingRef: finding });
    await store.deleteTask(canvas.id, prerequisite.id);
    const reloaded = await new CanvasStore(root).listTasks(canvas.id);
    expect(reloaded.find(task => task.id === dependent.id)).toMatchObject({ revision: 1, dependsOnTaskIds: [] });
    expect(reloaded.map((task: CanvasTask) => task.id)).not.toContain(prerequisite.id);
    await store.updateBlock(canvas.id, source.id, { linkTypes: null });
    const final = await new CanvasStore(root).getCanvasBlock(canvas.id, source.id);
    expect(final.linkTypes).toBeUndefined(); expect(final.links).toEqual([firstLink.id, secondLink.id]);
    expect(final.content).toBe(source.content);
  } finally { await rm(root, { recursive: true, force: true }); }
});
