import { afterEach, expect, it } from 'vitest';
import type { JevDocumentPatch, JevJob, JevMutation, JevProposal, JevVocabularyTerm } from '../../shared/jev-types.js';
import type { CanvasTask } from '../../shared/types.js';
import { automationPrincipal } from './authorization.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { sourceSnapshot } from './stamps.js';
import type { StoredJevReceipt } from './proposals.js';
import { JevFollowupQueue } from './followups.js';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });
async function fixture() {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'completed-source' };
  await native.followups.resume(native.workspaceId, request, [], 'completed-native-chain');
  return { native, request };
}
async function automaticDocument(native: QueueBoundaryFixture, patch: JevDocumentPatch) {
  return automaticMutation(native, { kind: 'document', canvasId: native.otherCanvasId, blockId: native.secondary.id, patch });
}
async function automaticMutation(native: QueueBoundaryFixture, mutation: JevMutation, action: JevProposal['action'] = 'label') {
  const block = await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id);
  const source = sourceSnapshot(native.workspaceId, native.otherCanvasId, block);
  const proposal: JevProposal = { id: `automatic-${(await native.files.read(native.workspaceId)).receipts.length}`, jobId: 'automatic-native-action',
    action, state: 'pending', createdAt: new Date().toISOString(), title: 'Checked automatic metadata', explanation: 'Native receipt proof',
    mutation, sources: [source],
    evidence: [{ source, start: 0, end: block.content.length, quote: block.content }] };
  const state = await native.files.read(native.workspaceId); state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  return native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposal.id, automationPrincipal, true));
}

it('keeps an unchanged completed source checked after unrelated automatic labels and links, without hydrating native canvas proofs', async () => {
  const { native, request } = await fixture();
  await automaticDocument(native, { tags: ['Automatic knowledge'], headline: 'Generated reference headline' });
  await automaticDocument(native, { crossLinks: [{ canvasId: native.canvasId, blockId: native.primary.id, relation: 'related' }] });
  const before = await native.files.read(native.workspaceId);
  let proofReads = 0;
  for (const receipt of before.receipts as StoredJevReceipt[]) for (const artifact of receipt.preparedArtifacts ?? []) {
    if (artifact.kind !== 'canvas') continue;
    for (const phase of ['before', 'after'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(artifact[phase], 'blocks')!;
      Object.defineProperty(artifact[phase], 'blocks', { ...descriptor,
        get: () => { proofReads += 1; return descriptor.get!.call(artifact[phase]); }, set: descriptor.set });
    }
  }
  await native.followups.maintenancePass(native.workspaceId, before)(request);
  expect(proofReads).toBe(0);
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
  expect((await native.files.read(native.workspaceId)).profiles).toEqual(before.profiles);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).content).toBe(native.primary.content);
});

it('keeps automatic vocabulary membership, version and alias-order updates stable while refreshing a changed semantic meaning once', async () => {
  const { native, request } = await fixture();
  const term: JevVocabularyTerm = { id: 'native-term', kind: 'label', name: 'Release evidence', definition: 'Declared release requirements',
    aliases: ['Rollout evidence', 'Delivery evidence'], state: 'active', version: 1,
    members: [{ canvasId: native.otherCanvasId, blockId: native.secondary.id }] };
  await automaticMutation(native, { kind: 'vocabulary', operation: 'define', term });
  await native.followups.queue(native.workspaceId, request);
  const refreshed = await native.files.read(native.workspaceId);
  expect(refreshed.jobs).toHaveLength(1); expect(refreshed.jobs[0].request.action).toBe('label');
  type ChainedJob = JevJob & { followupActions: JevJob['request']['action'][]; followupKey: string };
  for (let step = 0; step < 5; step += 1) {
    const state = await native.files.read(native.workspaceId);
    const pending = state.jobs.find(item => item.state === 'queued') as ChainedJob;
    pending.state = 'completed'; await native.files.write(native.workspaceId, state);
    await native.followups.resume(native.workspaceId, pending.request, pending.followupActions, pending.followupKey);
  }
  const checkpoint = await native.files.read(native.workspaceId);
  const updated = { ...term, version: 2, aliases: term.aliases.slice().reverse(),
    members: [...term.members, { canvasId: native.canvasId, blockId: native.primary.id }] };
  await automaticMutation(native, { kind: 'vocabulary', operation: 'restore', term: updated });
  await native.followups.queue(native.workspaceId, request);
  const stable = await native.files.read(native.workspaceId);
  expect(stable.jobs).toEqual(checkpoint.jobs); expect(stable.profiles).toEqual(checkpoint.profiles);
  await automaticMutation(native, { kind: 'vocabulary', operation: 'rename', term: { ...updated, version: 3, definition: 'Different declared acceptance evidence' } });
  await native.followups.queue(native.workspaceId, request);
  const changed = await native.files.read(native.workspaceId);
  expect(changed.jobs.filter(item => item.state === 'queued')).toHaveLength(1);
  await native.followups.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs).toEqual(changed.jobs);
});

it('retains manual task discussion and ownership as inputs while automatic attachment and assignment revisions remain outputs', async () => {
  const { native, request } = await fixture();
  const task = await native.store.createTask(native.otherCanvasId, { title: 'Review rollback', detail: 'Declared rollback work', blockIds: [] }, 'Browser');
  await native.followups.resume(native.workspaceId, request, [], 'completed-with-task');
  const update = async (patch: Partial<CanvasTask>) => {
    const current = (await native.store.listTasks(native.otherCanvasId))[0];
    return automaticMutation(native, { kind: 'task_update', canvasId: native.otherCanvasId, taskId: current.id,
      expectedUpdatedAt: current.updatedAt, expectedRevision: current.revision, patch });
  };
  await update({ blockIds: [native.secondary.id] }); await update({ assignee: 'release-owner' });
  const automatic = await native.files.read(native.workspaceId);
  await native.followups.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs).toEqual([]);
  expect((await native.files.read(native.workspaceId)).profiles).toEqual(automatic.profiles);
  await native.store.commentTask(native.otherCanvasId, task.id, 'Manual review criterion changed.', 'Browser');
  await native.followups.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs).toHaveLength(1);
});

it.each(['group', 'tags', 'crossLinks'] as const)('still refreshes for a genuine manual %s correction after automatic metadata', async field => {
  const { native, request } = await fixture();
  await automaticDocument(native, { tags: ['Automatic knowledge'] });
  const patch = { group: { group: 'custom:manual' }, tags: { tags: ['Manual knowledge'] },
    crossLinks: { crossLinks: [{ canvasId: native.canvasId, blockId: native.primary.id, relation: 'related' as const }] } }[field];
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, patch, 'Browser');
  await native.followups.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs).toHaveLength(1);
});

it('atomically ignores a stale maintenance plan when an original continuation was queued while its real context read was held', async () => {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'held-maintenance' };
  const stale = await native.files.read(native.workspaceId);
  await native.followups.queue(native.workspaceId, request);
  const terminal = await native.files.read(native.workspaceId);
  const first = terminal.jobs[0] as JevJob & { followupActions: JevJob['request']['action'][]; followupKey: string };
  first.state = 'completed'; await native.files.write(native.workspaceId, terminal);
  let release!: () => void; let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  const list = native.store.listWorkspaces.bind(native.store); let hold = true;
  native.store.listWorkspaces = async () => {
    const workspaces = await list();
    if (hold) { hold = false; reached(); await held; }
    return workspaces;
  };
  const planning = native.followups.maintenancePass(native.workspaceId, stale)(request);
  await started;
  try {
    await automaticDocument(native, { tags: ['Generated while planning was held'] });
    await native.followups.resume(native.workspaceId, request, first.followupActions, first.followupKey);
  } finally { release(); }
  await planning;
  const jobs = (await native.files.read(native.workspaceId)).jobs;
  expect(jobs).toHaveLength(2);
  expect(jobs.filter(job => job.state === 'queued').map(job => job.request.action)).toEqual(['link']);
});

it('protects a live completed frontier before its continuation starts, then lets that same native chain progress and recover after restart', async () => {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const live = new Set<string>();
  const followups = new JevFollowupQueue(native.store, native.files, (id, request) => native.enqueue(id, request), id => live.has(id));
  const request = { action: 'profile' as const, canvasId: native.canvasId, blockIds: [native.primary.id], idempotencyKey: 'held-frontier' };
  const stale = await native.files.read(native.workspaceId);
  await followups.queue(native.workspaceId, request);
  await automaticDocument(native, { tags: ['Generated at the completion frontier'] });
  const state = await native.files.read(native.workspaceId);
  const first = state.jobs[0] as JevJob & { followupActions: JevJob['request']['action'][]; followupKey: string };
  first.state = 'completed'; live.add(first.id); await native.files.write(native.workspaceId, state);
  const otherRuntime = new JevFollowupQueue(native.store, native.files, (id, request) => native.enqueue(id, request), id => live.has(id));
  await otherRuntime.maintenancePass(native.workspaceId, stale)(request);
  expect((await native.files.read(native.workspaceId)).jobs).toHaveLength(1);
  await followups.resume(native.workspaceId, request, first.followupActions, first.followupKey);
  const continued = await native.files.read(native.workspaceId);
  expect(continued.jobs).toHaveLength(2);
  expect(continued.jobs.find(job => job.state === 'queued')?.request.action).toBe('link');
  live.clear();
  const next = continued.jobs.find(job => job.state === 'queued')!; next.state = 'completed'; await native.files.write(native.workspaceId, continued);
  const restarted = new JevFollowupQueue(native.store, native.files, (id, request) => native.enqueue(id, request));
  await restarted.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs.filter(job => job.state === 'queued')).toHaveLength(1);
});


it('keeps earlier durable completion current after a sibling gains checked automatic groups, labels and a logical index', async () => {
  const { native, request } = await fixture();
  const checkpoint = (await native.files.read(native.workspaceId)).profiles[`${native.canvasId}:${native.primary.id}`];
  const term: JevVocabularyTerm = { id: 'automatic-sibling-group', kind: 'group', name: 'Rollback reference',
    groupKey: 'custom:rollback', definition: 'Checked rollback reference procedures', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: native.otherCanvasId, blockId: native.secondary.id }] };
  await automaticMutation(native, { kind: 'vocabulary', operation: 'define', term }, 'file');
  await automaticDocument(native, { group: term.groupKey, tags: ['Rollback'] });
  await automaticMutation(native, { kind: 'derived', blockId: native.secondary.id,
    values: { logicalIndex: { version: 1, topics: [{ name: 'Rollback', confidence: .95, evidence: [] }] } } }, 'profile');
  const state = await native.files.read(native.workspaceId);
  expect(await native.followups.checkpointInside(native.workspaceId, structuredClone(state), request,
    String(checkpoint.organizationKey))).toBe(false);
  await native.followups.queue(native.workspaceId, request);
  const unchanged = await native.files.read(native.workspaceId);
  expect(unchanged.jobs).toEqual([]); expect(unchanged.profiles).toEqual(state.profiles);
  expect(unchanged.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual(checkpoint);
  expect(unchanged.vocabulary).toEqual([term]);
  expect(await native.store.getCanvasBlock(native.otherCanvasId, native.secondary.id)).toMatchObject({ group: term.groupKey, tags: ['Rollback'] });
});

it('invalidates completion after a manual definition or version edit to an automatically created group', async () => {
  const { native, request } = await fixture();
  const term: JevVocabularyTerm = { id: 'automatic-group', kind: 'group', name: 'Rollback', groupKey: 'custom:rollback',
    definition: 'Checked rollback procedures', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: native.otherCanvasId, blockId: native.secondary.id }] };
  await automaticMutation(native, { kind: 'vocabulary', operation: 'define', term }, 'file');
  await native.followups.resume(native.workspaceId, request, [], 'current-with-automatic-group');
  const changed = await native.files.read(native.workspaceId);
  changed.vocabulary[0] = { ...term, version: 2, definition: 'Manual release approval requirements' };
  await native.files.write(native.workspaceId, changed);
  await native.followups.queue(native.workspaceId, request);
  const refreshed = await native.files.read(native.workspaceId);
  expect(refreshed.jobs).toHaveLength(1); expect(refreshed.jobs[0].request.action).toBe('label');
  await native.followups.queue(native.workspaceId, request);
  expect((await native.files.read(native.workspaceId)).jobs).toEqual(refreshed.jobs);
});
