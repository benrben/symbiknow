import { afterEach, expect, it, vi } from 'vitest';
import type { JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { processingPolicyKey } from './runtime-guards.js';
import type { StoredJevJob } from './runtime-queue.js';
import { commitWorkspaceJobs, stageWorkspaceJob, type WorkspaceCompletion } from './runtime-workspace-completion.js';
import { sourceSnapshot } from './stamps.js';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const native of fixtures.splice(0)) await native.close(); });

async function fixture(principal: JevPrincipal = boundaryOwner) {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  let state = await native.files.read(native.workspaceId);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, native.primary);
  for (const action of ['profile', 'link'] as const) {
    const proposal: JevProposal = { id: `${action}-proposal`, jobId: `${action}-job`, action, title: action,
      explanation: 'Native staged source proof', sources: [source], evidence: [], state: 'pending', createdAt: new Date().toISOString(),
      mutation: { kind: 'derived', blockId: native.primary.id, values: { [action]: 'checked' } } };
    const job: StoredJevJob = { id: proposal.jobId, request: { action, canvasId: native.canvasId, blockIds: [native.primary.id] },
      state: 'running', createdAt: proposal.createdAt, updatedAt: proposal.createdAt, sources: [source], proposalIds: [proposal.id],
      result: { status: 'reviewed' }, principal, authorizationFingerprint: principalFingerprint(principal),
      settingsKey: processingPolicyKey(state), attempts: 1 };
    state.jobs.push(job); state.proposals.push(proposal);
  }
  await native.files.write(native.workspaceId, state); state = await native.files.read(native.workspaceId);
  const controller = new AbortController();
  const inputs: WorkspaceCompletion[] = state.jobs.map(current => ({ ...native, state, current: current as StoredJevJob,
    job: structuredClone(current) as StoredJevJob, signal: controller.signal, principal, reason: () => undefined }));
  return { native, state, inputs, controller };
}

it('stages two actions without durable writes then commits separate receipts and results once', async () => {
  const { native, state, inputs } = await fixture();
  const before = await native.files.read(native.workspaceId);
  const write = vi.spyOn(native.files, 'write'); const unchanged = vi.spyOn(native.files, 'assertUnchanged');
  for (const input of inputs) expect(await stageWorkspaceJob(input)).toBe(true);
  expect(write).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
  expect(await native.files.read(native.workspaceId)).toEqual(before);
  expect(state.receipts.map(receipt => receipt.action)).toEqual(['profile', 'link']);
  await commitWorkspaceJobs(inputs);
  expect(write).toHaveBeenCalledTimes(1); expect(unchanged).toHaveBeenCalledTimes(1);
  const saved = await native.files.read(native.workspaceId);
  expect(saved.jobs.every(job => job.state === 'completed' && job.result?.status === 'reviewed')).toBe(true);
  expect(saved.receipts).toEqual(state.receipts); expect(saved.revision).toBe(before.revision + 1);
});

it('requires an explicit pending root to persist a checked prefix without completing the document operation', async () => {
  const { native, inputs } = await fixture();
  for (const input of inputs) await stageWorkspaceJob(input);
  inputs[0].current.state = 'running';
  await expect(commitWorkspaceJobs(inputs)).rejects.toMatchObject({ status: 400 });
  inputs[0].pendingDocumentRoot = true;
  await commitWorkspaceJobs(inputs);
  const saved = await native.files.read(native.workspaceId);
  expect(saved.jobs.map(job => job.state)).toEqual(['running', 'completed']);
  expect(saved.receipts.map(receipt => receipt.action)).toEqual(['profile', 'link']);
});

it.each(['abort', 'source', 'policy', 'replacement', 'authorization'])('rejects %s after staging without publishing any action', async reason => {
  const { native, inputs, controller } = await fixture();
  for (const input of inputs) await stageWorkspaceJob(input);
  if (reason === 'abort') controller.abort();
  if (reason === 'source') await native.store.updateBlock(native.canvasId, native.primary.id, { content: '# Human edit' }, 'Browser');
  if (reason === 'policy') inputs[0].state.settings.paused = true;
  if (reason === 'replacement') {
    const newer = await native.files.read(native.workspaceId); newer.profiles.human = { role: 'retained' };
    await native.files.write(native.workspaceId, newer);
  }
  if (reason === 'authorization') inputs[1].job.principal = { id: 'revoked-token', kind: 'token', access: 'write' };
  const before = await native.files.read(native.workspaceId); const write = vi.spyOn(native.files, 'write');
  await expect(commitWorkspaceJobs(inputs)).rejects.toBeInstanceOf(ApiError);
  expect(write).not.toHaveBeenCalled(); expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it('rechecks a genuinely revoked token before publishing staged automatic effects', async () => {
  const { native, inputs } = await fixture();
  const created = await native.store.createMcpToken('Native staged writer', 'write', { allowedCanvasIds: [native.canvasId], tools: ['jev_do'] });
  const identity = await native.store.mcpTokenIdentity(created.token);
  const principal: JevPrincipal = { ...identity!, kind: 'token' };
  for (const input of inputs) {
    input.current.principal = principal; input.current.authorizationFingerprint = principalFingerprint(principal);
    input.job = structuredClone(input.current); input.principal = automationPrincipal;
    await stageWorkspaceJob(input);
  }
  await native.store.revokeMcpToken(principal.id);
  const before = await native.files.read(native.workspaceId);
  await expect(commitWorkspaceJobs(inputs)).rejects.toMatchObject({ status: 403, message: 'The agent authorization was revoked' });
  expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it('validates shared supporting context inside the commit boundary before publishing a document result', async () => {
  const { native, inputs } = await fixture();
  const supporting = sourceSnapshot(native.workspaceId, native.otherCanvasId, native.secondary);
  for (const input of inputs) await stageWorkspaceJob(input);
  inputs[0].validateContext = () => native.store.jevExecutor.checkSources([supporting]);
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { content: '# Changed supporting evidence' }, 'Browser');
  const before = await native.files.read(native.workspaceId); const write = vi.spyOn(native.files, 'write');
  await expect(commitWorkspaceJobs(inputs)).rejects.toMatchObject({ status: 409 });
  expect(write).not.toHaveBeenCalled(); expect(await native.files.read(native.workspaceId)).toEqual(before);
});

it('restores a fatally rejected action in memory while retaining a previously staged action', async () => {
  const { native, state, inputs } = await fixture();
  await stageWorkspaceJob(inputs[0]);
  const before = JSON.stringify(state);
  const apply = native.executor.applyWorkspaceInside.bind(native.executor);
  vi.spyOn(native.executor, 'applyWorkspaceInside').mockImplementation(async (...args) => {
    await apply(...args); throw new ApiError(403, 'Native revoked approval after staging');
  });
  await expect(stageWorkspaceJob(inputs[1])).rejects.toMatchObject({ status: 403 });
  expect(JSON.stringify(state)).toBe(before);
  expect((await native.files.read(native.workspaceId)).receipts).toEqual([]);
});

it('rolls back a rejected candidate effect and commits the independent successful action with its hold', async () => {
  const { native, state, inputs } = await fixture();
  await stageWorkspaceJob(inputs[0]);
  const apply = native.executor.applyWorkspaceInside.bind(native.executor);
  vi.spyOn(native.executor, 'applyWorkspaceInside').mockImplementation(async (...args) => {
    await apply(...args); throw new ApiError(409, 'Native rejected candidate');
  });
  await stageWorkspaceJob(inputs[1]); await commitWorkspaceJobs(inputs);
  expect(state.receipts.map(receipt => receipt.action)).toEqual(['profile']);
  expect(state.profiles[`${native.canvasId}:${native.primary.id}`].link).toBeUndefined();
  expect(state.proposals[1]).toMatchObject({ state: 'stale', automaticHoldReason: 'Native rejected candidate' });
  expect(state.proposals[1].receiptId).toBeUndefined();
  expect(state.jobs[1].result?.automaticFailures).toEqual([{ proposalId: state.proposals[1].id, reason: 'Native rejected candidate' }]);
});

it('stages a no-change action and refuses canonical proposals without effects', async () => {
  const { state, inputs } = await fixture(); inputs[0].current.proposalIds = [];
  expect(await stageWorkspaceJob(inputs[0])).toBe(true); expect(inputs[0].current.state).toBe('completed');
  state.proposals[1].mutation = { kind: 'document', canvasId: inputs[1].job.request.canvasId,
    blockId: inputs[1].job.request.blockIds![0], patch: { group: 'custom:atlas' } };
  const before = JSON.stringify(state);
  expect(await stageWorkspaceJob(inputs[1])).toBe(false); expect(JSON.stringify(state)).toBe(before);
});

it.each(['current', 'changed source', 'revoked permission'])('stages a held canonical result without an intent write while checking %s', async guard => {
  const { native, state, inputs } = await fixture(); const input = inputs[0];
  const proposal = state.proposals[0];
  proposal.mutation = { kind: 'document', canvasId: native.canvasId, blockId: native.primary.id, patch: { group: 'custom:atlas' } };
  proposal.state = 'dismissed'; proposal.automaticHoldReason = 'Manual organization is preserved';
  if (guard === 'revoked permission') {
    const created = await native.store.createMcpToken('Native held writer', 'write', { allowedCanvasIds: [native.canvasId], tools: ['jev_do'] });
    const principal: JevPrincipal = { ...(await native.store.mcpTokenIdentity(created.token))!, kind: 'token' };
    input.current.principal = principal; input.current.authorizationFingerprint = principalFingerprint(principal);
    input.job = structuredClone(input.current); input.principal = principal;
  }
  const canonical = vi.spyOn(native.executor, 'applyInside'); const workspace = vi.spyOn(native.executor, 'applyWorkspaceInside');
  const write = vi.spyOn(native.files, 'write');
  expect(await stageWorkspaceJob(input)).toBe(true);
  expect(canonical).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  if (guard === 'changed source') await native.store.updateBlock(native.canvasId, native.primary.id, { content: '# Changed held source' }, 'Browser');
  if (guard === 'revoked permission') await native.store.revokeMcpToken(input.job.principal.id);
  if (guard === 'current') {
    await commitWorkspaceJobs([input]); expect(write).toHaveBeenCalledTimes(1);
    const saved = await native.files.read(native.workspaceId);
    expect(saved.proposals[0]).toMatchObject({ state: 'dismissed', automaticHoldReason: 'Manual organization is preserved' });
    expect(saved.jobs[0].state).toBe('completed'); expect(saved.receipts).toEqual([]);
    expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).group).toEqual(native.primary.group);
  } else {
    await expect(commitWorkspaceJobs([input])).rejects.toBeInstanceOf(ApiError);
    expect(write).not.toHaveBeenCalled(); expect((await native.files.read(native.workspaceId)).jobs[0].state).toBe('running');
  }
});
