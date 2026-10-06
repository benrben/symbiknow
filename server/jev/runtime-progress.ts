import { SYMBI_CONTRACT_VERSION, type SymbiActionName, type SymbiActionProgress,
  type SymbiDocumentProgress } from '../../shared/symbi-contract.js';
import type { JevJob, JevProposal, JevWorkspaceState } from '../../shared/jev-types.js';
import { documentActions, type DocumentJob } from './runtime-document.js';

function valueRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedValue(value: unknown, limit: number): unknown {
  if (value === undefined) return {};
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded) <= limit ? value : { truncated: true, bytes: Buffer.byteLength(encoded) };
}
function boundedCandidate(value: unknown): unknown {
  const bounded = boundedValue(value, 2_048);
  if (!valueRecord(bounded) || bounded.truncated !== true || !valueRecord(value)) return bounded;
  const option = valueRecord(value.option) ? value.option : value;
  return { truncated: true,
    ...Object.fromEntries(['blockId', 'kind', 'id', 'name', 'sourceId', 'targetId', 'targetCanvasId', 'origin']
      .filter(key => typeof value[key] === 'string' || typeof value[key] === 'number').map(key => [key, value[key]])),
    ...(typeof option.origin === 'string' ? { origin: option.origin } : {}) };
}
function inspectionCandidates(result: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = Array.isArray(result.candidateOptions) ? [...result.candidateOptions] : [];
  const documents = valueRecord(result.documents) ? result.documents : {};
  for (const [blockId, value] of Object.entries(documents).slice(0, 16)) {
    if (!valueRecord(value)) continue;
    for (const key of ['decisionOptions', 'options', 'candidateOptions']) {
      if (!(key in value)) continue;
      const options = value[key];
      if (Array.isArray(options)) candidates.push(...options.slice(0, 24).map(option => ({ blockId, option })));
      else candidates.push({ blockId, kind: key, options });
    }
  }
  return candidates.slice(0, 24).map(boundedCandidate);
}

function actionJob(jobs: Map<string, JevJob>, root: DocumentJob, action: SymbiActionName): JevJob | undefined {
  if (action === 'profile') return root;
  return jobs.get(`${root.id}:${action}`) ??
    (root.documentPlan?.activeJob?.request.action === action ? root.documentPlan.activeJob : undefined);
}

function savedOutcome(job: JevJob): Pick<SymbiActionProgress, 'state' | 'reason'> | undefined {
  const retained = job.result?.progressOutcome;
  if (!valueRecord(retained) || !['waiting', 'changed', 'no_change', 'failed'].includes(String(retained.state))) return undefined;
  return { state: retained.state as SymbiActionProgress['state'],
    ...(typeof retained.reason === 'string' ? { reason: retained.reason } : {}) };
}
function noChangeReason(job: JevJob, candidates: JevProposal[]): string {
  if (typeof job.result?.reason === 'string') return job.result.reason;
  return candidates.find(candidate => candidate.automaticHoldReason)?.automaticHoldReason
    ?? String(job.result?.status ?? 'No supported change');
}
function inspectedEvidence(proposal: JevProposal) {
  const visible = proposal.evidence.filter(passage => passage.quote.length <= 2_048
    && proposal.sources.some(source => source.canvasId === passage.source.canvasId
      && source.blockId === passage.source.blockId && source.contentHash === passage.source.contentHash));
  return { evidence: visible.slice(0, 4), evidenceTruncated: visible.length !== proposal.evidence.length || visible.length > 4 };
}
function outcome(job: JevJob | undefined, proposals: Map<string, JevProposal>): Pick<SymbiActionProgress, 'state' | 'reason'> {
  if (!job) return { state: 'no_change', reason: 'Completed; detailed decision was compacted' };
  const retained = savedOutcome(job);
  if (retained) return retained;
  if (job.state === 'failed') return { state: 'failed', reason: job.error ?? 'Decision failed' };
  const candidates = job.proposalIds.map(id => proposals.get(id)).filter((item): item is JevProposal => Boolean(item));
  if (candidates.some(candidate => candidate.state === 'applied')) return { state: 'changed' };
  return { state: 'no_change', reason: noChangeReason(job, candidates) };
}

/** The current six-action frontier reads durable jobs and proposals only; historical receipts are never scanned on poll. */
export function documentProgress(state: JevWorkspaceState, jobId: string): SymbiDocumentProgress | undefined {
  const jobs = new Map(state.jobs.map(job => [job.id, job]));
  const root = jobs.get(jobId) as DocumentJob | undefined;
  const proposals = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  return root ? progressFromRoot(root, jobs, proposals) : undefined;
}

function progressFromRoot(root: DocumentJob, jobs: Map<string, JevJob>,
  proposals: Map<string, JevProposal>): SymbiDocumentProgress | undefined {
  const plan = root?.documentPlan;
  const source = plan?.originalSources[0];
  if (!root || !plan || !source) return undefined;
  const complete = new Set(plan.completedActions);
  const actions: SymbiActionProgress[] = documentActions.map(action => {
    const decision = actionJob(jobs, root, action);
    if (plan.failedAction === action) return { action, state: 'failed', reason: plan.failureReason ?? 'Decision failed',
      ...(decision ? { decisionId: decision.id } : {}) };
    if (!complete.has(action)) return { action, state: 'waiting', ...(decision ? { decisionId: decision.id } : {}) };
    return { action, ...outcome(decision, proposals), ...(decision ? { decisionId: decision.id } : {}) };
  });
  const durable = root.state === 'completed' && Boolean(plan.completionPreparedAt)
    && documentActions.every(action => complete.has(action));
  return { version: SYMBI_CONTRACT_VERSION, jobId: root.id, canvasId: source.canvasId, blockId: source.blockId,
    contentHash: source.contentHash, ...(durable ? { checkpointId: root.id } : {}), durable,
    updatedAt: root.updatedAt, actions };
}

export function documentProgresses(state: JevWorkspaceState): SymbiDocumentProgress[] {
  const jobs = new Map(state.jobs.map(job => [job.id, job]));
  const proposals = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  return state.jobs.flatMap(job => (job as DocumentJob).documentPlan
    ? progressFromRoot(job as DocumentJob, jobs, proposals) ?? [] : []);
}

/** Call only after authorization has scoped the state; full details are intentionally kept out of progress polling. */
export function decisionInspection(state: JevWorkspaceState, jobId: string, action: SymbiActionName) {
  const root = state.jobs.find(job => job.id === jobId) as DocumentJob | undefined;
  if (!root?.documentPlan) return undefined;
  const decision = actionJob(new Map(state.jobs.map(job => [job.id, job])), root, action);
  if (!decision) return undefined;
  const proposals = decision.proposalIds.slice(0, 16).map(id => state.proposals.find(proposal => proposal.id === id))
    .filter((item): item is JevProposal => Boolean(item));
  const result = valueRecord(decision.result) ? decision.result : {};
  return { jobId: decision.id, action, state: decision.state,
    options: boundedValue(decision.request.options ?? {}, 4_096), candidateOptions: inspectionCandidates(result),
    result: boundedValue(result, 32_768), proposals: proposals.map(proposal => ({ id: proposal.id, title: proposal.title,
      state: proposal.state, confidence: proposal.confidence, decisionConfidences: proposal.decisionConfidences,
      reason: proposal.automaticHoldReason, ...inspectedEvidence(proposal) })) };
}
