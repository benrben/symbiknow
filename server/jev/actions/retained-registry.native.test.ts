import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CanvasStore } from '../../storage.js';
import { evaluateJevAction, type JevEvaluationContext } from '../actions.js';
import { evaluationContext } from '../context.js';
import { emptyJevWorkspace } from '../workspace.js';

let root: string; let context: JevEvaluationContext; let canvasId: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-retained-registry-'));
  const store = new CanvasStore(root); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Retained action boundary' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' });
  context = await evaluationContext(store, workspaceId, emptyJevWorkspace(), { action: 'profile', canvasId },
    { id: 'owner', kind: 'user', access: 'write' }, new AbortController().signal);
  context.decider = async () => { throw new Error('Invalid requests must not reach the provider'); };
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it.each(['digest', 'vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall'] as const)('rejects removed %s before provider evaluation at the native registry boundary', async action => {
  await expect(evaluateJevAction(context, { action, canvasId })).rejects.toMatchObject({ status: 400 });
});
it('rejects a canvas outside the evaluated workspace before provider evaluation', async () => {
  await expect(evaluateJevAction(context, { action: 'profile', canvasId: 'outside-canvas' })).rejects.toMatchObject({ status: 404 });
});
