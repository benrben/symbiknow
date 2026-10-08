import { createHash } from 'node:crypto';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../shared/jev-types.js';
import type { CanvasStore } from './storage.js';
import { ApiError } from './errors.js';
import { JevWorkspaceFiles } from './jev/workspace.js';

function duplicateProposal(proposal: JevProposal, canvas: CanvasDocument): boolean {
  return proposal.action === 'flag_duplicate' && proposal.state === 'applied'
    && proposal.mutation.kind === 'derived' && proposal.mutation.values.kind === 'duplicate'
    && proposal.sources.length === 2 && proposal.sources.every(source => source.canvasId === canvas.id);
}

function sourceCurrent(block: CanvasBlock, source: JevSourceSnapshot, workspaceId: string): boolean {
  return source.workspaceId === workspaceId && block.incarnation === source.incarnation
    && block.sourceGeneration === source.sourceGeneration && block.contentHash === source.contentHash
    && !block.archived && !block.processingExcluded;
}

async function currentPair(store: CanvasStore, canvas: CanvasDocument, proposal: JevProposal) {
  const pair: CanvasBlock[] = [];
  for (const source of proposal.sources) {
    try {
      const block = await store.getCanvasBlock(canvas.id, source.blockId);
      if (!sourceCurrent(block, source, canvas.workspaceId)) return;
      pair.push(block);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  }
  return pair;
}

function addPair(findings: Map<string, NonNullable<CanvasBlock['jevDuplicates']>>, pair: CanvasBlock[], findingId: string) {
  for (const [index, block] of pair.entries()) {
    const related = pair[1 - index];
    const previous = findings.get(block.id) ?? [];
    if (previous.some(item => item.blockId === related.id)) continue;
    findings.set(block.id, [...previous, { findingId, blockId: related.id, title: related.title }]);
  }
}

async function duplicateFindings(store: CanvasStore, canvas: CanvasDocument, state: JevWorkspaceState) {
  const findings = new Map<string, NonNullable<CanvasBlock['jevDuplicates']>>();
  const applied = new Set(state.receipts.filter(receipt => receipt.state === 'applied').map(receipt => receipt.proposalId));
  for (const proposal of state.proposals.filter(proposal => duplicateProposal(proposal, canvas) && applied.has(proposal.id))) {
    const pair = await currentPair(store, canvas, proposal);
    if (pair) addPair(findings, pair, proposal.id);
  }
  return findings;
}

/** Current, scoped evidence marks both endpoints; findings never become stored source metadata. */
export async function projectCanvasJevStatus(store: CanvasStore, canvas: CanvasDocument): Promise<CanvasDocument> {
  try {
    const state = await new JevWorkspaceFiles(store.root).read(canvas.workspaceId);
    const findings = await duplicateFindings(store, canvas, state);
    return { ...canvas, blocks: canvas.blocks.map(block => ({ ...block, jevDuplicates: findings.get(block.id) })) };
  } catch {
    return { ...canvas, jevStatusError: 'Automatic findings could not load. Open Symbi Reflex to retry; your documents are available.' };
  }
}

/** A new or cleared finding invalidates full-canvas conditional reads without changing source history. */
export function canvasJevStatusRevision(revision: string, canvas: CanvasDocument): string {
  const findings = canvas.blocks.filter(block => block.jevDuplicates?.length).map(block => [block.id, block.jevDuplicates]);
  if (!findings.length && !canvas.jevStatusError) return revision;
  return `"${createHash('sha256').update(revision).update(JSON.stringify([findings, canvas.jevStatusError])).digest('hex')}"`;
}

export function withCanvasJevStatus(canvas: CanvasDocument, summary: CanvasDocument): CanvasDocument {
  const findings = new Map(summary.blocks.map(block => [block.id, block.jevDuplicates]));
  return { ...canvas, groupLabels: summary.groupLabels, jevStatusError: summary.jevStatusError,
    blocks: canvas.blocks.map(block => ({ ...block, jevDuplicates: findings.get(block.id) })) };
}
