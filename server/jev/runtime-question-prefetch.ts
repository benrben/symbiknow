import { createHash } from 'node:crypto';
import type { JevActionRequest, JevCurrentAction, JevEvaluation } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { decideWithJev, type JevDecider } from '../jev.js';
import { evaluateJevAction } from './actions.js';
import type { JevEvaluationContext } from './actions/context.js';
import { batchedDiscoveryContext } from './actions/discovery-batch.js';
import type { QuestionAnswerCache } from './actions/question-answer-cache.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';

// Labels consume the fresh profile index; filing consumes the labels and links applied later.
const independentActions: JevCurrentAction[] = ['link', 'flag_duplicate', 'suggest_home_canvas'];

type QuestionTransport = { apiKey?: string; fetcher?: typeof fetch; decider?: JevDecider };
export function questionTransportChanged(current: QuestionTransport, next: QuestionTransport): boolean {
  return (['apiKey', 'fetcher', 'decider'] as const).some(key => Object.hasOwn(next, key) && current[key] !== next[key]);
}

function exactAutomation(job: StoredJevJob): boolean {
  const expected = principalFingerprint(automationPrincipal);
  return job.principal.id === automationPrincipal.id && principalFingerprint(job.principal) === expected
    && job.authorizationFingerprint === expected;
}

function explicitScope(job: StoredJevJob): boolean {
  const request = job.request;
  return request.query === undefined && request.options === undefined && Boolean(request.blockIds?.length);
}

function sourceIdentities(context: JevEvaluationContext) {
  return context.documents
    .map(({ snapshot }) => ({ canvasId: snapshot.canvasId, blockId: snapshot.blockId,
      incarnation: snapshot.incarnation, sourceGeneration: snapshot.sourceGeneration, contentHash: snapshot.contentHash }))
    .sort((left, right) => left.canvasId.localeCompare(right.canvasId) || left.blockId.localeCompare(right.blockId));
}

function completeSelection(context: JevEvaluationContext, request: JevActionRequest): boolean {
  return context.documents.filter(document => document.canvasId === request.canvasId && request.blockIds!.includes(document.block.id))
    .length === request.blockIds!.length;
}

/** Answer reuse never crosses automation authorization, processing policy, or source incarnations. */
export function automaticQuestionPartition(context: JevEvaluationContext, job: StoredJevJob): string | undefined {
  if (!exactAutomation(job) || !explicitScope(job)) return undefined;
  if (!completeSelection(context, job.request)) return undefined;
  return createHash('sha256').update(JSON.stringify({ workspaceId: context.workspaceId,
    canvasId: job.request.canvasId, selectedIds: [...job.request.blockIds!].sort(),
    authorization: job.authorizationFingerprint, policy: job.settingsKey, sources: sourceIdentities(context) })).digest('hex');
}

export function cachedQuestionContext(context: JevEvaluationContext, cache: QuestionAnswerCache, partition: string): JevEvaluationContext {
  const wrapDecider = (transport: NonNullable<JevEvaluationContext['decider']>) => cache.decider(partition, transport);
  const uncachedDecider = context.decider ?? decideWithJev;
  return { ...context, decider: wrapDecider(uncachedDecider), wrapDecider, uncachedDecider, shareQuestionSources: true };
}

export function shouldPrefetchQuestions(context: JevEvaluationContext, request: JevActionRequest): boolean {
  return request.action === 'profile' && context.settings.externalProcessing && Boolean(request.blockIds?.length)
    && request.blockIds!.length <= 8;
}

function prefetchRequests(context: JevEvaluationContext, request: JevActionRequest): JevActionRequest[] {
  return independentActions.filter(action => context.settings.modes[action] === 'auto')
    .map(action => ({ action, canvasId: request.canvasId, blockIds: request.blockIds }));
}

/** Only answers are prefetched. Every later action builds new proposals against its fresh canonical context. */
export async function evaluateWithQuestionPrefetch(context: JevEvaluationContext, request: JevActionRequest,
  cache: QuestionAnswerCache, partition: string): Promise<JevEvaluation> {
  const batched = cachedQuestionContext(batchedDiscoveryContext({ ...context, shareQuestionSources: true }, setImmediate), cache, partition);
  const requests = [request, ...prefetchRequests(context, request)];
  const results = await Promise.allSettled(requests.map(item => evaluateJevAction(batched, item)));
  if (context.signal?.aborted) throw new ApiError(499, 'Symbi Reflex evaluation was cancelled');
  const primary = results[0];
  if (primary.status === 'rejected') throw primary.reason;
  // Failed optional reads are retried by their ordinary durable action, rather than marking that action completed.
  const deferred = results.flatMap((result, index) => result.status === 'rejected' ? [requests[index].action] : []);
  if (deferred.length) primary.value.result.prefetchDeferredActions = deferred;
  return primary.value;
}
