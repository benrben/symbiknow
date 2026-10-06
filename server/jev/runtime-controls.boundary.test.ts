import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevJob, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { emptyJevWorkspace } from './workspace.js';
import { stageJevDraft, readJevDraft, type JevDraft } from './drafts.js';
import { sourceSnapshot } from './stamps.js';
import { cancelDraftWork, checkDraftCancellation, checkJobCancellation, metadataOwnership, stopJobDraft, validateMetadataOverride } from './runtime-controls.js';
import type { StoredJevJob } from './runtime-queue.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true };
const agent: JevPrincipal = { id: 'agent-a', kind: 'token', access: 'propose' };
let root: string; let store: CanvasStore; let workspaceId: string; let canvasId: string; let blockId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-controls-')); store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Control boundaries' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  blockId = (await store.createBlock(canvasId, { title: 'Source', content: '# Native source', group: 'custom:manual', tags: ['manual'] })).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function job(action: JevJob['request']['action'] = 'review_agent_edit'): StoredJevJob {
  return { id: 'held-job', request: { action, canvasId, blockIds: [blockId], options: { draftId: 'draft-a', draftGeneration: 1 } },
    state: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sources: [], proposalIds: [], principal: agent,
    authorizationFingerprint: 'fixture-agent', settingsKey: 'fixture-settings', attempts: 1 };
}
async function draft(): Promise<JevDraft> {
  const block = await store.getCanvasBlock(canvasId, blockId);
  return stageJevDraft(root, sourceSnapshot(workspaceId, canvasId, block), { id: 'draft-a', baseContent: block.content, proposedContent: block.content + '\nChecked change', instruction: 'Append checked change' }, agent.id);
}
it('checks initiating agent identity and canvas grants before job or draft cancellation', async () => {
  expect(() => checkJobCancellation(undefined, owner)).toThrow('Job not found');
  expect(() => checkJobCancellation(job(), { ...agent, allowedCanvasIds: [] })).toThrow('Job not found');
  expect(() => checkJobCancellation(job(), { ...agent, id: 'agent-b' })).toThrow('Only the initiating agent');
  expect(() => checkJobCancellation(job(), agent)).not.toThrow();
  const held = await draft();
  expect(() => checkDraftCancellation(null, held.id, owner)).toThrow('Draft not found');
  expect(() => checkDraftCancellation(held, 'different', owner)).toThrow('Draft not found');
  expect(() => checkDraftCancellation({ ...held, state: 'applied' }, held.id, owner)).toThrow('checked Undo');
  expect(() => checkDraftCancellation(held, held.id, { ...agent, id: 'agent-b' })).toThrow('Only the initiating agent');
  expect(() => checkDraftCancellation(held, held.id, agent)).not.toThrow();
  expect(() => checkDraftCancellation(held, held.id, owner)).not.toThrow();
});
it('persists cancellation for the exact durable draft generation and leaves unrelated work untouched', async () => {
  await draft();
  await stopJobDraft(store, { ...job('profile') }, 'cancelled');
  await stopJobDraft(store, { ...job(), request: { action: 'review_agent_edit', canvasId } }, 'cancelled');
  await stopJobDraft(store, { ...job(), request: { action: 'review_agent_edit', canvasId, blockIds: [blockId], options: {} } }, 'cancelled');
  expect((await readJevDraft(root, canvasId, blockId))?.state).toBe('staged');
  await stopJobDraft(store, job(), 'review_unavailable');
  expect((await readJevDraft(root, canvasId, blockId))?.state).toBe('review_unavailable');
  const state = emptyJevWorkspace(); const active = job(); const complete = { ...job(), id: 'complete', state: 'completed' as const };
  state.jobs = [active, complete, { ...job(), id: 'unrelated', request: { action: 'profile', canvasId } }];
  state.proposals = [{ id: 'content', state: 'pending', mutation: { kind: 'content', draftId: 'draft-a' } },
    { id: 'other-draft', state: 'pending', mutation: { kind: 'content', draftId: 'draft-b' } },
    { id: 'metadata', state: 'pending', mutation: { kind: 'document' } }] as JevProposal[];
  const controller = new AbortController(); cancelDraftWork(state, 'draft-a', new Map([[active.id, controller]]));
  expect(controller.signal.aborted).toBe(true); expect(active.state).toBe('cancelled'); expect(complete.state).toBe('completed');
  expect(state.proposals.map(item => item.state)).toEqual(['dismissed', 'pending', 'pending']);
});
it('validates explicit ownership fields and edge keys without accepting overlapping or forged fields', () => {
  for (const patch of [{ unexpected: true }, { pins: 'group' }, { managed: [1] }, { pins: ['link:bad/path:target'] }, { pins: ['group'], managed: ['group'] }])
    expect(() => validateMetadataOverride(patch)).toThrow();
  expect(() => validateMetadataOverride({ pins: ['linkTypes', 'workArea', `link:${canvasId}:${blockId}`], managed: ['tags'] })).not.toThrow();
});
it('restores null metadata fields, preserves removal memory and accepts explicit pins or managed ownership', async () => {
  const canvas = await store.getCanvas(canvasId, true);
  expect(() => metadataOwnership(canvas, 'missing-source', {})).toThrow('Document not found');
  const result = metadataOwnership(canvas, blockId, { tags: null, crossLinks: null, quality: null, pins: ['group'], managed: ['tags'] });
  expect(result.pins).toEqual(['group']); expect(result.managed).toEqual(['tags']); expect(result.removedLabels).toEqual(['manual']);
  expect(metadataOwnership(canvas, blockId, { pins: ['tags'] }).managed).not.toContain('tags');
  await store.updateBlock(canvasId, blockId, { group: 'custom:corrected-manually' }, 'Browser');
  const corrected = await store.getCanvas(canvasId, true);
  expect(corrected.blocks.find(block => block.id === blockId)?.jevOwnership?.pins).toContain('group');
  expect(metadataOwnership(corrected, blockId, { managed: ['group'] }).pins).not.toContain('group');
});
