import { describe, expect, it } from 'vitest';
import { jevActions, type JevAction } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import { canRunJevCandidate } from './runtime-parallel-policy.js';
import type { JevQueuedCandidate } from './runtime-scheduler.js';

const localActions = ['profile', 'label'] as const;
function candidate(action: JevAction = 'profile', blockIds = ['one'], workspaceId = 'workspace', canvasId = 'canvas'): JevQueuedCandidate {
  return { workspaceId, job: { id: `${workspaceId}:${canvasId}:${blockIds.join(',')}:${action}`,
    request: { action, canvasId, blockIds }, principal: automationPrincipal, state: 'queued', attempts: 0,
    createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z', proposalIds: [],
    settingsKey: 'settings', authorizationFingerprint: 'principal', sources: blockIds.map(blockId => ({
      workspaceId, canvasId, blockId, incarnation: `inc_${blockId}`, sourceGeneration: 2, metadataRevision: 3, contentHash: `hash_${blockId}` })) } };
}

describe('safe Jev worker parallelism', () => {
  it.each(localActions.flatMap(action => localActions.map(activeAction => [action, activeAction] as const)))(
    'allows disjoint automatic %s with %s and rejects their overlapping source', (action, activeAction) => {
      const next = candidate(action); const current = candidate(activeAction, ['two']);
      expect(canRunJevCandidate(next, [current])).toBe(true);
      expect(canRunJevCandidate(next, [candidate(activeAction)])).toBe(false);
    });
  it.each(jevActions.filter(action => !localActions.includes(action as typeof localActions[number])))(
    'keeps automatic %s exclusive in both directions', action => {
      const broad = candidate(action, ['one']); const local = candidate('profile', ['two']);
      expect(canRunJevCandidate(broad, [])).toBe(true);
      expect(canRunJevCandidate(broad, [local])).toBe(false);
      expect(canRunJevCandidate(local, [broad])).toBe(false);
    });
  it('keeps manual and other-agent work exclusive even for otherwise local actions', () => {
    const manual = candidate('profile'); manual.job.principal = { id: 'owner', kind: 'user', access: 'write' };
    const agent = candidate('label'); agent.job.principal = { id: 'other-agent', kind: 'token', access: 'write' };
    const local = candidate('profile', ['two']);
    expect(canRunJevCandidate(manual, [])).toBe(true);
    expect(canRunJevCandidate(manual, [local])).toBe(false);
    expect(canRunJevCandidate(local, [manual])).toBe(false);
    expect(canRunJevCandidate(agent, [local])).toBe(false);
    expect(canRunJevCandidate(local, [agent])).toBe(false);
    manual.job.principal.id = automationPrincipal.id;
    expect(canRunJevCandidate(manual, [local])).toBe(false);
    const anotherAutomation = candidate('profile'); anotherAutomation.job.principal = { ...automationPrincipal, id: 'other-automation' };
    expect(canRunJevCandidate(anotherAutomation, [local])).toBe(false);
  });
  it('keeps workspaces independent and distinguishes equal document IDs on different canvases', () => {
    const next = candidate('profile'); const otherWorkspace = candidate('file', ['one'], 'other-workspace');
    expect(canRunJevCandidate(next, [otherWorkspace])).toBe(true);
    expect(canRunJevCandidate(candidate('link'), [otherWorkspace])).toBe(true);
    expect(canRunJevCandidate(next, [candidate('label', ['one'], 'workspace', 'other-canvas')])).toBe(true);
    expect(canRunJevCandidate(next, [otherWorkspace, candidate('profile', ['two'])])).toBe(true);
  });
  it('checks every selected source of every same-workspace worker without mutating their snapshots', () => {
    const next = candidate('profile', ['one', 'two']);
    const active = [candidate('label', ['three']), candidate('profile', ['four', 'two']), candidate('file', ['one'], 'other-workspace')];
    const original = structuredClone({ next, active });
    expect(canRunJevCandidate(next, active)).toBe(false);
    expect(canRunJevCandidate(next, active.filter(item => item.job.request.action !== 'profile'))).toBe(true);
    expect({ next, active }).toEqual(original);
  });
  it.each(['missing_ids', 'empty_ids', 'missing_sources', 'empty_sources', 'wrong_workspace', 'wrong_canvas', 'unselected_source', 'missing_selected_source'] as const)(
    'treats %s as exclusive instead of assuming a safe local scope', boundary => {
      const unsafe = candidate('profile');
      if (boundary === 'missing_ids') delete unsafe.job.request.blockIds;
      if (boundary === 'empty_ids') unsafe.job.request.blockIds = [];
      if (boundary === 'missing_sources') unsafe.job.sources = undefined as unknown as typeof unsafe.job.sources;
      if (boundary === 'empty_sources') unsafe.job.sources = [];
      if (boundary === 'wrong_workspace') unsafe.job.sources[0].workspaceId = 'other-workspace';
      if (boundary === 'wrong_canvas') unsafe.job.sources[0].canvasId = 'other-canvas';
      if (boundary === 'unselected_source') unsafe.job.sources[0].blockId = 'unselected';
      if (boundary === 'missing_selected_source') unsafe.job.request.blockIds!.push('missing');
      const valid = candidate('label', ['two']);
      expect(canRunJevCandidate(unsafe, [])).toBe(true);
      expect(canRunJevCandidate(unsafe, [valid])).toBe(false);
      expect(canRunJevCandidate(valid, [unsafe])).toBe(false);
    });
});
