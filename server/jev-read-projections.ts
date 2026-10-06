import type { JevJob, JevProposal, JevReceipt, JevWorkspaceState } from '../shared/jev-types.js';
import { mutationCanvases } from './jev/authorization.js';

type Options = { limit?: number; cursor?: number; canvasId?: string; paginated?: boolean };
function page<T>(items: T[], options: Options) {
  const offset = options.cursor ?? 0;
  const limit = options.limit ?? 25;
  return { items: items.slice(offset, offset + limit),
    nextCursor: offset + limit < items.length ? String(offset + limit) : undefined };
}
function contains(value: string | undefined, query: string): boolean {
  return !query || (value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
function sourceMatches(sources: Array<{ canvasId: string; blockId: string }>, id?: string, canvasId?: string): boolean {
  return sources.some(source => (!id || source.blockId === id) && (!canvasId || source.canvasId === canvasId));
}
function jobMatches(job: JevJob, id: string | undefined, query: string, canvasId?: string): boolean {
  if (canvasId && job.request.canvasId !== canvasId) return false;
  if (id && !job.request.blockIds?.includes(id) && !sourceMatches(job.sources, id, canvasId)) return false;
  return contains(job.request.action, query) || contains(job.state, query) || contains(job.request.query, query);
}
function compactJob(job: JevJob) {
  return { id: job.id, action: job.request.action, canvasId: job.request.canvasId, blockIds: job.request.blockIds ?? [],
    state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt, proposalCount: job.proposalIds.length,
    ...(job.error ? { error: job.error.slice(0, 240) } : {}) };
}
function compactReceipt(receipt: JevReceipt, canvasId?: string) {
  return { id: receipt.id, proposalId: receipt.proposalId, action: receipt.action, state: receipt.state,
    actor: receipt.actor, createdAt: receipt.createdAt, automatic: receipt.automatic,
    sources: receipt.sourcesAfter.filter(source => !canvasId || source.canvasId === canvasId)
      .map(source => ({ canvasId: source.canvasId, blockId: source.blockId })) };
}
function proposalMatches(proposal: JevProposal, id: string | undefined, query: string, canvasId?: string): boolean {
  if (canvasId && (proposal.sources.some(source => source.canvasId !== canvasId)
    || mutationCanvases(proposal.mutation).some(mutationCanvas => mutationCanvas !== canvasId))) return false;
  if ((id || canvasId) && !sourceMatches(proposal.sources, id, canvasId)) return false;
  return contains(proposal.title, query) || contains(proposal.action, query) || contains(proposal.explanation, query);
}

/** Transport adapters use the same bounded projection of an already scope-filtered state. */
export function projectJevState(name: string, state: JevWorkspaceState, id?: string, query = '', options: Options = {}): unknown {
  if (name === 'jev_job') return projectJob(state, id, options.canvasId);
  if (name === 'jev_activity') {
    const jobs = state.jobs.filter(job => jobMatches(job, id, query, options.canvasId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(compactJob);
    const receipts = state.receipts.filter(receipt => (!id && !options.canvasId)
      || sourceMatches(receipt.sourcesAfter, id, options.canvasId)).filter(receipt => contains(receipt.action, query))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(receipt => compactReceipt(receipt, options.canvasId));
    const jobPage = page(jobs, options);
    const receiptPage = page(receipts, options);
    return { jobs: jobPage.items, receipts: receiptPage.items, nextCursor: jobPage.nextCursor ?? receiptPage.nextCursor };
  }
  if (name === 'brain_inbox') {
    const selected = page(state.proposals.filter(item => item.state === 'pending'
    && proposalMatches(item, id, query, options.canvasId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), options);
    return options.paginated ? selected : selected.items;
  }
  if (name === 'memory_map') {
    const selected = page(state.vocabulary.filter(term => contains(term.name, query)
    || contains(term.definition, query)).map(term => ({ id: term.id, name: term.name, kind: term.kind,
    state: term.state, groupKey: term.groupKey, definition: term.definition.slice(0, 240),
    memberCount: term.members.filter(member => (!id || member.blockId === id)
      && (!options.canvasId || member.canvasId === options.canvasId)).length }))
    .filter(term => (!id && !options.canvasId) || term.memberCount > 0), options);
    return options.paginated ? selected : selected.items;
  }
  if (name === 'related') return { items: [], reason: 'Use the indexed related-document endpoint for current source relationships.' };
  const profiles = Object.entries(state.profiles).filter(([key, value]) => {
    const [canvasId, blockId] = key.split(':');
    return (!options.canvasId || canvasId === options.canvasId) && (!id || blockId === id)
      && JSON.stringify(value).toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const selected = page(profiles, options);
  return { profiles: Object.fromEntries(selected.items), coverage: {
    scope: 'Stored profiles only; search complete indexed sources with ask_symbi.',
    selected: selected.items.length, total: profiles.length }, nextCursor: selected.nextCursor };
}

function projectJob(state: JevWorkspaceState, id: string | undefined, canvasId?: string): unknown {
  const job = state.jobs.find(item => item.id === id && (!canvasId || item.request.canvasId === canvasId));
  return job ? { job: compactJob(job), proposals: state.proposals.filter(item => item.jobId === id)
    .filter(item => !canvasId || proposalMatches(item, undefined, '', canvasId))
    .map(item => ({ id: item.id, state: item.state, action: item.action, title: item.title, confidence: item.confidence })) } : null;
}
