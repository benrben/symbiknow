import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicJson } from '../storage-files.js';
import { storedBlock, type StoredCanvas } from '../storage-shapes.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { initializeJevStamp, sourceSnapshot } from './stamps.js';

const fixtures: QueueBoundaryFixture[] = [];
async function fixture() {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
  const block = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const state = await native.files.read(native.workspaceId);
  state.profiles[`${native.canvasId}:${block.id}`] = { source: { ...sourceSnapshot(native.workspaceId, native.canvasId, block) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: 0.7 };
  await native.files.write(native.workspaceId, state);
  await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [block.id] });
  return native;
}
afterEach(async () => { for (const native of fixtures.splice(0)) await native.close(); });

it('does not rebuild full organization context when loaded source state already has a matching pending followup', async () => {
  const native = await fixture(); let calls = 0;
  const getCanvas = native.store.getCanvas.bind(native.store);
  native.store.getCanvas = async (id, archived, labels) => {
    if (archived === true && labels === false) calls += 1;
    return getCanvas(id, archived, labels);
  };
  const before = await native.files.read(native.workspaceId);
  await native.maintenance.reconcile(await native.workspace());
  expect(calls).toBe(0);
  expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it('skips 158 already queued native chains without rebuilding organization context for any source', async () => {
  const native = await fixture();
  const primary = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const blocks = [primary, ...Array.from({ length: 157 }, (_, index) => initializeJevStamp({
    ...primary, id: `native-source-${index}`, file: `docs/native-source-${index}.md`, incarnation: undefined,
    sourceGeneration: undefined, metadataRevision: undefined, jevOwnership: undefined,
    title: `Atlas source ${index}`, content: `# Atlas source ${index}\nAtlas rollout ${index} requirements.`,
    x: index * 32, y: index * 16 }))];
  await Promise.all(blocks.slice(1).map(block => writeFile(path.join(native.root, block.file), block.content)));
  const canvasFile = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const canvas = JSON.parse(await readFile(canvasFile, 'utf8')) as StoredCanvas;
  await atomicJson(canvasFile, { ...canvas, blocks: blocks.map(storedBlock) });
  const sources = blocks.map(block => sourceSnapshot(native.workspaceId, native.canvasId, block));
  const state = await native.files.read(native.workspaceId); const template = state.jobs[0];
  state.jobs = sources.map((source, index) => ({ ...template, id: `native-pending-${index}`,
    request: { ...template.request, blockIds: [source.blockId], idempotencyKey: `native-request-${index}` },
    sources: [source], contextSources: sources, followupSources: [source], followupKey: `native-chain-${index}` }));
  state.profiles = Object.fromEntries(sources.map(source => [`${source.canvasId}:${source.blockId}`, {
    source: { ...source }, questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: 0.7 }]));
  await native.files.write(native.workspaceId, state);
  let contexts = 0; const getCanvas = native.store.getCanvas.bind(native.store);
  native.store.getCanvas = async (id, archived, labels) => {
    if (archived === true && labels === false) contexts += 1;
    return getCanvas(id, archived, labels);
  };
  await native.maintenance.reconcile(await native.workspace());
  expect(contexts).toBe(0);
  expect(await native.files.read(native.workspaceId)).toEqual(state);
  const fresh = await native.store.getCanvas(native.canvasId, true, false);
  expect(fresh.blocks.map(block => [block.content, block.x, block.y])).toEqual(blocks.map(block => [block.content, block.x, block.y]));
});

it('does not read unrelated canvas bodies while checking an already pending selected source', async () => {
  const native = await fixture();
  await rm(path.join(native.root, native.secondary.file));
  const before = await native.files.read(native.workspaceId);
  let workspaceReads = 0; const list = native.store.listWorkspaces.bind(native.store);
  native.store.listWorkspaces = async (...args) => { workspaceReads += 1; return list(...args); };
  await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] });
  expect(workspaceReads).toBe(0);
  expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it.each(['cancelled', 'completed'] as const)('allows a %s native chain to queue fresh organization work', async status => {
  const native = await fixture(); const state = await native.files.read(native.workspaceId);
  const oldId = state.jobs[0].id; state.jobs[0].state = status; await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const pending = (await native.files.read(native.workspaceId)).jobs.filter(job => job.state === 'queued');
  expect(pending).toHaveLength(1);
  expect(pending[0].id).not.toBe(oldId); expect(pending[0].request.action).toBe('label');
});

it.each(['body', 'incarnation'] as const)('does not let an old native %s identity suppress a fresh followup', async boundary => {
  const native = await fixture();
  const oldId = (await native.files.read(native.workspaceId)).jobs[0].id;
  if (boundary === 'body') await native.store.updateBlock(native.canvasId, native.primary.id, { content: '# Atlas\nCorrected rollout requirements.' }, 'Browser');
  else {
    const canvasFile = path.join(native.root, 'canvases', `${native.canvasId}.json`);
    const canvas = JSON.parse(await readFile(canvasFile, 'utf8')) as StoredCanvas;
    canvas.blocks[0].incarnation = 'replacement-native-incarnation'; await atomicJson(canvasFile, canvas);
  }
  const current = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [current.id] });
  const jobs = (await native.files.read(native.workspaceId)).jobs;
  const fresh = jobs.filter(job => job.state === 'queued' && job.id !== oldId);
  expect(fresh).toHaveLength(1);
  const queued = fresh[0];
  expect(queued.sources).toEqual([sourceSnapshot(native.workspaceId, native.canvasId, current)]);
});

it('resumes repeatedly cancelled native chains with a new identity instead of reusing their cancelled work', async () => {
  const native = await fixture(); const identities = new Set<string>();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const state = await native.files.read(native.workspaceId);
    const pending = state.jobs.find(job => job.state === 'queued')!;
    identities.add(pending.id); pending.state = 'cancelled'; await native.files.write(native.workspaceId, state);
    await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] });
    const resumed = (await native.files.read(native.workspaceId)).jobs.find(job => job.state === 'queued')!;
    expect(identities.has(resumed.id)).toBe(false);
    expect(resumed.request.idempotencyKey).toContain(':resume:');
  }
});

it('checkpoints an exhausted native dependent failure before retrying its chain', async () => {
  const native = await fixture(); const state = await native.files.read(native.workspaceId);
  const failed = state.jobs[0] as typeof state.jobs[0] & { followupKey: string };
  failed.state = 'failed'; await native.files.write(native.workspaceId, state);
  await native.followups.fail(native.workspaceId, failed.request, failed.followupKey);
  const stopped = await native.files.read(native.workspaceId);
  expect(stopped.profiles[`${native.canvasId}:${native.primary.id}`].organizationFailedContextKey).toMatch(/^[a-f0-9]{64}$/);
  expect(Date.parse(String(stopped.profiles[`${native.canvasId}:${native.primary.id}`].organizationRetryAt))).toBeGreaterThan(Date.now());
  await native.followups.queue(native.workspaceId, { action: 'profile', canvasId: native.canvasId, blockIds: [native.primary.id] });
  expect(await native.files.read(native.workspaceId)).toEqual(stopped);
});

it.each(['cancelled', 'failed'] as const)('backfills a %s native profile with a fresh operation identity while respecting failure cooldown', async status => {
  const native = await fixture(); const state = await native.files.read(native.workspaceId);
  delete state.profiles[`${native.canvasId}:${native.primary.id}`]; await native.files.write(native.workspaceId, state);
  await native.maintenance.reconcile(await native.workspace());
  const admitted = await native.files.read(native.workspaceId);
  const original = admitted.jobs.find(job => job.request.action === 'profile')!;
  original.state = status; original.updatedAt = new Date().toISOString(); await native.files.write(native.workspaceId, admitted);
  if (status === 'failed') {
    await native.maintenance.reconcile(await native.workspace());
    expect(await native.files.read(native.workspaceId)).toEqual(admitted);
  }
  await native.maintenance.reconcile(await native.workspace(), new Date(Date.parse(original.updatedAt) + 61_000));
  const fresh = (await native.files.read(native.workspaceId)).jobs.find(job => job.request.action === 'profile' && job.state === 'queued')!;
  expect(fresh.id).not.toBe(original.id);
  expect(fresh.request.idempotencyKey).toContain(status === 'cancelled' ? ':retry:cancel:' : ':retry:');
  expect(fresh.sources).toEqual(original.sources);
});
