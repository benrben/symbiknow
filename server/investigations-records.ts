import { keyHash } from './investigations-access.js';
import type { Investigation, InvestigationPatch, InvestigationSummary, SavedInvestigation } from './investigations-types.js';

export function publicRecord(saved: SavedInvestigation): Investigation {
  const { keyHash: _keyHash, ...investigation } = saved;
  void _keyHash;
  return investigation;
}

export function summary(saved: SavedInvestigation): InvestigationSummary {
  const { id, workspaceId, canvasId, title, visibility, question, revision, createdAt, updatedAt } = saved;
  return { id, workspaceId, ...(canvasId ? { canvasId } : {}), title, visibility,
    ...(question ? { question } : {}), revision, createdAt, updatedAt,
    sourceCount: saved.sourceRefs.length, proposalCount: saved.proposalRefs.length, messageCount: saved.messages.length };
}

export function updatedRecord(saved: SavedInvestigation, patch: InvestigationPatch, nextKey: string | undefined): SavedInvestigation {
  const { expectedRevision: _revision, ...changes } = patch;
  void _revision;
  const definedChanges = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  const next: SavedInvestigation = { ...saved, ...definedChanges, revision: saved.revision + 1, updatedAt: new Date().toISOString(),
    ...(nextKey ? { keyHash: keyHash(nextKey) } : {}) };
  if (next.visibility === 'shared') delete next.keyHash;
  return next;
}
