import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const fixtures: QueueBoundaryFixture[] = [];
afterEach(async () => {
  for (const native of fixtures.splice(0)) {
    // Token identity reads enqueue an advisory last-used write. Drain the shared
    // storage writer before removing its root so the write cannot recreate it.
    await native.store.documentMetadata(native.primary);
    await native.close();
  }
});
async function fixture() {
  const native = await queueBoundaryFixture(); fixtures.push(native);
  const state = await native.files.read(native.workspaceId);
  const source = sourceSnapshot(native.workspaceId, native.canvasId, native.primary);
  const proposal: JevProposal = { id: randomUUID(), jobId: 'native-analysis', action: 'profile', title: 'Checked local analysis',
    explanation: 'Preserve exact local source and receipt evidence', sources: [source], evidence: [], state: 'pending',
    createdAt: new Date().toISOString(), mutation: { kind: 'derived', blockId: native.primary.id, values: { role: 'note', confidence: .91 } } };
  state.proposals.push(proposal); await native.files.write(native.workspaceId, state);
  return { native, proposal, state: await new JevWorkspaceFiles(native.root).read(native.workspaceId) };
}
function apply(native: QueueBoundaryFixture, state: JevWorkspaceState, id: string, supplied: JevPrincipal = automationPrincipal, automatic = true, recordAutomatic = automatic) {
  return native.executor.applyWorkspaceInside(native.workspaceId, state, id, supplied, automatic, recordAutomatic);
}

it('records the exact derived receipt in owned state without touching an unreadable ledger, then commits it with one caller-owned durable write', async () => {
  const { native, proposal, state } = await fixture();
  const canonical = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const file = native.files.file(native.workspaceId); const before = await readFile(file, 'utf8'); const backup = `${file}.before-transaction`;
  await rename(file, backup); await mkdir(file);
  let receipt;
  try {
    receipt = await apply(native, state, proposal.id);
    expect(receipt).toMatchObject({ proposalId: proposal.id, action: 'profile', actor: automationPrincipal.id,
      before: { kind: 'derived', blockId: native.primary.id, values: {} }, after: proposal.mutation,
      sourcesAfter: proposal.sources, state: 'applied', automatic: true });
    expect(state.proposals.find(item => item.id === proposal.id)).toMatchObject({ state: 'applied', receiptId: receipt.id });
    expect(state.receipts).toEqual([receipt]); expect(state.prepared).toEqual([]);
    expect(state.profiles[`${native.canvasId}:${native.primary.id}`]).toEqual({ role: 'note', confidence: .91, source: proposal.sources[0] });
    expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id))).toEqual(canonical);
  } finally { await rm(file, { recursive: true }); await rename(backup, file); }
  expect(await readFile(file, 'utf8')).toBe(before);
  const revision = state.revision; await native.files.write(native.workspaceId, state);
  const reloaded = await new JevWorkspaceFiles(native.root).read(native.workspaceId);
  expect(reloaded.revision).toBe(revision + 1); expect(reloaded.receipts).toEqual([receipt]);
  expect(reloaded.profiles).toEqual(state.profiles);
});

it('allows the caller to discard a fully checked in-memory transition without inventing durable completion', async () => {
  const { native, proposal, state } = await fixture(); const persisted = await native.files.read(native.workspaceId);
  await native.executor.applyWorkspaceInside(native.workspaceId, state, proposal.id, boundaryOwner);
  expect(state.receipts[0]).toMatchObject({ actor: boundaryOwner.id, automatic: false });
  expect(await new JevWorkspaceFiles(native.root).read(native.workspaceId)).toEqual(persisted);
});

it('returns an existing workspace receipt unchanged and leaves independent states and historical evidence intact', async () => {
  const { native, proposal, state } = await fixture(); const independent = await native.files.read(native.workspaceId);
  const receipt = await apply(native, state, proposal.id); const settled = JSON.stringify(state);
  expect(await apply(native, state, proposal.id)).toBe(receipt); expect(JSON.stringify(state)).toBe(settled);
  expect(independent.proposals.find(item => item.id === proposal.id)?.state).toBe('pending'); expect(independent.receipts).toEqual([]);
  expect(await native.files.read(native.workspaceId)).toEqual(independent);
});

it('checks a complete vocabulary definition and its native membership before recording its checked inverse', async () => {
  const { native, proposal, state } = await fixture();
  const term = { id: 'native-atlas-topic', kind: 'label' as const, name: 'Atlas', definition: 'Checked Atlas release sources',
    aliases: [], state: 'active' as const, version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] };
  state.proposals.find(item => item.id === proposal.id)!.mutation = { kind: 'vocabulary', operation: 'define', term };
  const receipt = await apply(native, state, proposal.id);
  expect(receipt.before).toEqual({ kind: 'vocabulary', operation: 'remove', term });
  expect(receipt.after).toEqual({ kind: 'vocabulary', operation: 'define', term }); expect(state.vocabulary).toEqual([term]);
  await native.files.write(native.workspaceId, state);
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).vocabulary).toEqual([term]);
});

const canonical: Array<{ label: string; mutation: (native: QueueBoundaryFixture) => JevMutation }> = [
  { label: 'missing saved mutation', mutation: () => null as never },
  { label: 'document', mutation: n => ({ kind: 'document', canvasId: n.canvasId, blockId: n.primary.id, patch: { group: 'custom:atlas' } }) },
  { label: 'task', mutation: n => ({ kind: 'task_create', canvasId: n.canvasId, task: { title: 'Create a native task', detail: 'Native checked task creation' } }) },
  { label: 'move', mutation: n => ({ kind: 'move', canvasId: n.canvasId, blockId: n.primary.id, targetCanvasId: n.otherCanvasId }) },
  { label: 'content', mutation: n => ({ kind: 'content', canvasId: n.canvasId, blockId: n.primary.id, content: '# Changed', expectedContentHash: n.primary.contentHash!, draftId: 'native-review' }) },
];
it.each(canonical)('refuses $label mutation before effects at the workspace-only boundary', async row => {
  const { native, proposal, state } = await fixture(); state.proposals.find(item => item.id === proposal.id)!.mutation = row.mutation(native);
  const before = JSON.stringify(state); const canonical = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  await expect(apply(native, state, proposal.id)).rejects.toMatchObject({ status: 400, message: 'This transaction requires a workspace-only mutation' });
  expect(JSON.stringify(state)).toBe(before); expect(await native.store.getCanvasBlock(native.canvasId, native.primary.id)).toEqual(canonical);
});

it.each(['missing', 'dismissed', 'paused', 'invalid-values', 'unapproved-user', 'canvas-scope', 'self-approval'])
('preserves the public proposal guard for %s before mutating owned state', async label => {
  const { native, proposal, state } = await fixture(); let id = proposal.id; let principal = automationPrincipal; let automatic = true;
  if (label === 'missing') id = 'missing';
  if (label === 'dismissed') state.proposals.find(item => item.id === id)!.state = 'dismissed';
  if (label === 'paused') state.settings.paused = true;
  if (label === 'invalid-values') (state.proposals.find(item => item.id === id)!.mutation as { values: unknown }).values = null;
  if (label === 'unapproved-user') { principal = { id: 'unapproved', kind: 'user', access: 'write' }; automatic = false; }
  if (label === 'canvas-scope') principal = { ...automationPrincipal, allowedCanvasIds: [native.otherCanvasId] };
  if (label === 'self-approval') {
    const token = await native.store.createMcpToken('Native source agent', 'propose', { allowedCanvasIds: [native.canvasId], tools: ['jev_propose'] });
    principal = { ...(await native.store.mcpTokenIdentity(token.token))!, kind: 'token' };
    state.jobs.push({ id: proposal.jobId, request: { action: 'profile' }, state: 'completed', principal } as never);
  }
  const before = JSON.stringify(state);
  await expect(apply(native, state, id, principal, automatic)).rejects.toMatchObject({ status: label === 'missing' || label === 'canvas-scope' ? 404
    : ['dismissed', 'paused'].includes(label) ? 409 : label === 'invalid-values' ? 400 : 403 });
  expect(JSON.stringify(state)).toBe(before);
});

it('rechecks native sources inside the canonical serialization boundary after the first checked snapshot changes', async () => {
  const { native, proposal, state } = await fixture(); const before = JSON.stringify(state);
  const checked = native.store.jevExecutor.checkSources.bind(native.store.jevExecutor); let calls = 0;
  native.store.jevExecutor.checkSources = async sources => {
    await checked(sources); calls++;
    if (calls === 1) await native.store.updateBlock(native.canvasId, native.primary.id, { content: '# Changed after the first source check' }, 'Browser');
  };
  await expect(apply(native, state, proposal.id)).rejects.toMatchObject({ status: 409, message: 'The source changed since Symbi Reflex reviewed it' });
  expect(calls).toBe(1); expect(JSON.stringify(state)).toBe(before);
  expect((await new JevWorkspaceFiles(native.root).read(native.workspaceId)).receipts).toEqual([]);
});

it('refuses a real foreign-workspace vocabulary member before applying a definition', async () => {
  const { native, proposal, state } = await fixture();
  const foreign = (await native.store.createWorkspace({ name: 'Foreign membership' })).id;
  const canvas = (await native.store.createCanvas(foreign, { name: 'Foreign source' })).id;
  const block = await native.store.createBlock(canvas, { title: 'Foreign source', content: '# Foreign' });
  state.proposals.find(item => item.id === proposal.id)!.mutation = { kind: 'vocabulary', operation: 'define', term: {
    id: 'native-foreign-label', kind: 'label', name: 'Foreign label', definition: 'Foreign sources', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: canvas, blockId: block.id }],
  } };
  const before = JSON.stringify(state);
  await expect(apply(native, state, proposal.id)).rejects.toMatchObject({ status: 409, message: 'A vocabulary member is unavailable in this workspace' });
  expect(JSON.stringify(state)).toBe(before);
});

it('retains the native group-reference guard before removing a workspace definition', async () => {
  const { native, proposal, state } = await fixture();
  await native.store.updateBlock(native.canvasId, native.primary.id, { group: 'custom:atlas' }, 'Browser');
  const source = sourceSnapshot(native.workspaceId, native.canvasId, await native.store.getCanvasBlock(native.canvasId, native.primary.id));
  const term = { id: 'native-atlas-group', kind: 'group' as const, groupKey: 'custom:atlas', name: 'Atlas', definition: 'Atlas release evidence',
    aliases: [], state: 'active' as const, version: 1, members: [{ canvasId: native.canvasId, blockId: native.primary.id }] };
  state.vocabulary = [term];
  const saved = state.proposals.find(item => item.id === proposal.id)!;
  saved.sources = [source]; saved.mutation = { kind: 'vocabulary', operation: 'remove', term };
  const before = JSON.stringify(state);
  await expect(apply(native, state, proposal.id)).rejects.toMatchObject({ status: 409,
    message: 'Undo the document placements before removing their group definition' });
  expect(JSON.stringify(state)).toBe(before);
  expect((await native.store.getCanvasBlock(native.canvasId, native.primary.id)).group).toBe('custom:atlas');
});
