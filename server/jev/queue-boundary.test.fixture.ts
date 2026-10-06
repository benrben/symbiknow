import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jevActions, type JevActionRequest, type JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { JevWorkspaceFiles, emptyJevWorkspace } from './workspace.js';
import { JevProposalExecutor } from './proposals.js';
import { enqueueJevJob } from './runtime-queue.js';
import { JevFollowupQueue } from './followups.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';

export const boundaryOwner: JevPrincipal = { id: 'native-owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
export async function queueBoundaryFixture(initialize = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'reflex-queue-boundary-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Native queue boundaries' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Atlas guide' })).id;
  const primary = await store.createBlock(canvasId, { title: 'Atlas delivery', content: '# Atlas\nDelivery must follow the guide on 2026-10-04.\n- [ ] Check rollout' });
  const otherCanvasId = (await store.createCanvas(workspaceId, { name: 'Rollback reference' })).id;
  const secondary = await store.createBlock(otherCanvasId, { title: 'Rollback reference', content: '# Rollback\nChecked rollback source.' });
  const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
  if (initialize) {
    const state = emptyJevWorkspace(); state.settings.externalProcessing = true;
    state.settings.modes = Object.fromEntries(jevActions.map(action => [action, 'auto'])) as typeof state.settings.modes;
    await files.write(workspaceId, state);
  }
  const enqueue = (id: string, request: JevActionRequest, principal = boundaryOwner) => enqueueJevJob(store, files, executor, id, request, principal);
  const admit = (request: JevActionRequest, principal = boundaryOwner) => files.serial(workspaceId, () => enqueue(workspaceId, request, principal));
  const followups = new JevFollowupQueue(store, files, (id, request) => enqueue(id, request)); const running = new Map<string, AbortController>();
  const maintenance = new JevRuntimeMaintenance(store, files, executor, followups, enqueue, running);
  const workspace = () => store.listWorkspaces().then(items => items.find(item => item.id === workspaceId)!);
  return { root, store, workspaceId, canvasId, primary, otherCanvasId, secondary, files, executor, enqueue, admit, followups, running, maintenance,
    workspace, close: () => rm(root, { recursive: true, force: true }) };
}
export type QueueBoundaryFixture = Awaited<ReturnType<typeof queueBoundaryFixture>>;
