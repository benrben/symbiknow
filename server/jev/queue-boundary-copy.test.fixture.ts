import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JevActionRequest } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevWorkspaceFiles } from './workspace.js';
import { JevProposalExecutor } from './proposals.js';
import { enqueueJevJob } from './runtime-queue.js';
import { JevFollowupQueue } from './followups.js';
import { JevRuntimeMaintenance } from './runtime-maintenance.js';

/** Copy a real, completed native baseline; each case owns all bytes, Git history and store instances. */
export async function queueBoundaryCopies(prepared?: QueueBoundaryFixture) {
  const template = prepared ?? await queueBoundaryFixture();
  async function fixture(): Promise<QueueBoundaryFixture> {
    const root = await mkdtemp(path.join(tmpdir(), 'reflex-queue-copy-'));
    await cp(template.root, root, { recursive: true });
    const store = new CanvasStore(root); await store.init();
    const files = new JevWorkspaceFiles(root); const executor = new JevProposalExecutor(store, files);
    const { workspaceId, canvasId, otherCanvasId } = template;
    const primary = structuredClone(template.primary); const secondary = structuredClone(template.secondary);
    const enqueue = (id: string, request: JevActionRequest, principal = boundaryOwner) => enqueueJevJob(store, files, executor, id, request, principal);
    const admit = (request: JevActionRequest, principal = boundaryOwner) => files.serial(workspaceId, () => enqueue(workspaceId, request, principal));
    const followups = new JevFollowupQueue(store, files, (id, request) => enqueue(id, request)); const running = new Map<string, AbortController>();
    const maintenance = new JevRuntimeMaintenance(store, files, executor, followups, enqueue, running);
    const workspace = () => store.listWorkspaces().then(items => items.find(item => item.id === workspaceId)!);
    return { root, store, workspaceId, canvasId, primary, otherCanvasId, secondary, files, executor, enqueue, admit, followups,
      running, maintenance, workspace, close: () => rm(root, { recursive: true, force: true }) };
  }
  return { fixture, close: template.close };
}
