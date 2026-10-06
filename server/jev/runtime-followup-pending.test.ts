import { describe, expect, it } from 'vitest';
import type { JevJob, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { hasPendingCanvasFollowup, hasPendingSourceFollowup } from './runtime-followup-pending.js';
import { emptyJevWorkspace } from './workspace.js';

const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'one',
  incarnation: 'incarnation', sourceGeneration: 7, metadataRevision: 12, contentHash: 'current-hash' };
type FollowupFixtureJob = JevJob & { followupActions?: string[]; followupSources?: JevSourceSnapshot[] };
function state(state: JevJob['state'] = 'queued'): JevWorkspaceState {
  const job: FollowupFixtureJob = { id: 'job', request: { action: 'link', canvasId: 'canvas', blockIds: ['one'] },
    state, questionVersion: 'version', sources: [source, { ...source, blockId: 'two' }], proposalIds: [],
    createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z', followupActions: [] };
  return { ...emptyJevWorkspace(), jobs: [job] };
}

describe('pending source followup identity and request scope', () => {
  it.each(['queued', 'running'] as const)('retains a %s chain despite generated metadata revisions', status => {
    const current = state(status);
    expect(hasPendingSourceFollowup(current, { ...source, metadataRevision: 99 })).toBe(true);
    expect(hasPendingCanvasFollowup(current, 'canvas')).toBe(true);
    expect(hasPendingCanvasFollowup(current, 'other')).toBe(false);
  });
  it.each(['completed', 'cancelled', 'failed'] as const)('allows a %s chain to be checked for new work', status => {
    expect(hasPendingSourceFollowup(state(status), source)).toBe(false);
    expect(hasPendingCanvasFollowup(state(status), 'canvas')).toBe(false);
  });
  it.each(['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const)(
    'does not reuse another %s identity', field => {
      const changed = { ...source, [field]: field === 'sourceGeneration' ? 8 : 'different' };
      expect(hasPendingSourceFollowup(state(), changed)).toBe(false);
    });
  it('does not treat link context snapshots as selected work or an ordinary queued job as a followup', () => {
    const current = state();
    expect(hasPendingSourceFollowup(current, { ...source, blockId: 'two' })).toBe(false);
    delete (current.jobs[0] as FollowupFixtureJob).followupActions;
    expect(hasPendingSourceFollowup(current, source)).toBe(false);
    expect(hasPendingCanvasFollowup(current, 'canvas')).toBe(false);
  });
  it('uses the original chain sources and respects canvas-wide requests without explicit IDs', () => {
    const current = state();
    const job = current.jobs[0] as JevJob & { followupSources?: JevSourceSnapshot[] };
    job.followupSources = [{ ...source, sourceGeneration: 6 }];
    expect(hasPendingSourceFollowup(current, source)).toBe(false);
    job.followupSources = [source]; job.request.blockIds = undefined;
    expect(hasPendingSourceFollowup(current, source)).toBe(true);
    job.request.blockIds = [];
    expect(hasPendingSourceFollowup(current, source)).toBe(true);
    expect(hasPendingSourceFollowup(emptyJevWorkspace(), source)).toBe(false);
    expect(hasPendingCanvasFollowup(emptyJevWorkspace(), 'canvas')).toBe(false);
  });
});
