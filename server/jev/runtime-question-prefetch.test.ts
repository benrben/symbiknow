import { expect, it } from 'vitest';
import { jevActions, type JevActionRequest } from '../../shared/jev-types.js';
import type { JevAnswer, JevDecider, JevQuestion } from '../jev.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import { QuestionAnswerCache } from './actions/question-answer-cache.js';
import type { JevEvaluationContext } from './actions/context.js';
import type { StoredJevJob } from './runtime-queue.js';
import { emptyJevWorkspace } from './workspace.js';
import { automaticQuestionPartition, cachedQuestionContext, evaluateWithQuestionPrefetch,
  questionTransportChanged, shouldPrefetchQuestions } from './runtime-question-prefetch.js';

const request: JevActionRequest = { action: 'profile', canvasId: 'canvas', blockIds: ['source'] };
function context(): JevEvaluationContext {
  const snapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source', incarnation: 'original',
    sourceGeneration: 1, metadataRevision: 0, contentHash: 'exact-source' };
  return { workspaceId: 'workspace', documents: [{ canvasId: 'canvas', snapshot,
    block: { id: 'source', title: 'Source guide', file: 'docs/source.md', kind: 'markdown', content: '# Source guide\nChecked evidence.',
      x: 1, y: 2, width: 400, height: 300, links: [] } }],
    canvases: [{ id: 'canvas', name: 'Source guide' }], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings, apiKey: 'pure-native-key' };
}
function job(): StoredJevJob {
  return { id: 'job', principal: automationPrincipal, authorizationFingerprint: principalFingerprint(automationPrincipal),
    settingsKey: 'checked-policy', attempts: 0, request: structuredClone(request), sources: [context().documents[0].snapshot],
    createdAt: '2026-10-04', updatedAt: '2026-10-04', state: 'running', proposalIds: [] };
}
function answers(questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: 0.01 }];
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]));
    return [id, question.type === 'choice' ? { type: 'choice', choice: keys[0], confidence: 1, probabilities }
      : { type: 'score', score: 0, confidence: 1, probabilities }];
  }));
}
function primaryAndHome(): JevEvaluationContext {
  const value = context();
  for (const action of jevActions) value.settings.modes[action] = 'off';
  value.settings.modes.profile = 'auto'; value.settings.modes.suggest_home_canvas = 'auto';
  value.canvases.unshift({ id: 'destination', name: 'Destination reference' });
  return value;
}
it('partitions exact automation independently of automatic metadata revisions and incidental source/request ordering', () => {
  const value = context(); const second = structuredClone(value.documents[0]); second.block.id = 'second'; second.snapshot.blockId = 'second';
  const selected = job(); selected.request.blockIds!.push('second'); value.documents.push(second);
  value.documents.push({ ...structuredClone(second), canvasId: 'outside', snapshot: { ...second.snapshot, canvasId: 'outside' } });
  const first = automaticQuestionPartition(value, selected);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  value.documents[0].snapshot.metadataRevision += 1; value.documents.reverse(); selected.request.blockIds!.reverse();
  expect(automaticQuestionPartition(value, selected)).toBe(first);
  expect(automaticQuestionPartition(context(), job())).toMatch(/^[a-f0-9]{64}$/);
});

const scopeChanges: Record<string, (selected: StoredJevJob) => void> = {
  manual: selected => { selected.principal = { id: 'owner', kind: 'user', access: 'write' }; },
  grant: selected => { selected.principal = { ...automationPrincipal, allowedCanvasIds: ['canvas'] }; },
  authorization: selected => { selected.authorizationFingerprint = 'old-grant'; },
  query: selected => { selected.request.query = 'Explicit custom query'; },
  options: selected => { selected.request.options = {}; },
  absent: selected => { delete selected.request.blockIds; },
  empty: selected => { selected.request.blockIds = []; },
  missing: selected => { selected.request.blockIds = ['unavailable']; },
  duplicate: selected => { selected.request.blockIds = ['source', 'source']; },
};
it.each(Object.entries(scopeChanges))('declines reuse for %s scope', (_changed, change) => {
  const selected = job();
  change(selected);
  expect(automaticQuestionPartition(context(), selected)).toBeUndefined();
});

const identityChanges: Record<string, (value: JevEvaluationContext, selected: StoredJevJob) => void> = {
  incarnation: value => { value.documents[0].snapshot.incarnation = 'recreated'; },
  sourceGeneration: value => { value.documents[0].snapshot.sourceGeneration += 1; },
  contentHash: value => { value.documents[0].snapshot.contentHash = 'new-bytes'; },
  workspace: value => { value.workspaceId = 'another-workspace'; },
  policy: (_value, selected) => { selected.settingsKey = 'new-policy'; },
  canvas: (value, selected) => {
    value.documents[0].canvasId = 'another-canvas'; value.documents[0].snapshot.canvasId = 'another-canvas'; selected.request.canvasId = 'another-canvas';
  },
};
it.each(Object.entries(identityChanges))('separates a changed %s from the previous source partition', (_changed, change) => {
  const value = context(); const selected = job(); const before = automaticQuestionPartition(value, selected);
  change(value, selected);
  expect(automaticQuestionPartition(value, selected)).not.toBe(before);
});

it.each(['incarnation', 'sourceGeneration', 'contentHash'] as const)('invalidates cached neighbor judgments when an unselected source changes %s', field => {
  const value = context(); const outside = structuredClone(value.documents[0]);
  outside.block.id = 'unselected'; outside.snapshot.blockId = 'unselected';
  outside.canvasId = 'another-canvas'; outside.snapshot.canvasId = 'another-canvas'; value.documents.push(outside);
  const before = automaticQuestionPartition(value, job());
  if (field === 'sourceGeneration') outside.snapshot[field] += 1;
  else outside.snapshot[field] = 'changed-unselected-source';
  expect(automaticQuestionPartition(value, job())).not.toBe(before);
});

it('invalidates cached workspace questions when an unselected source is added or removed', () => {
  const value = context(); const before = automaticQuestionPartition(value, job());
  const outside = structuredClone(value.documents[0]); outside.block.id = 'outside'; outside.snapshot.blockId = 'outside';
  value.documents.push(outside); expect(automaticQuestionPartition(value, job())).not.toBe(before);
  value.documents.pop(); expect(automaticQuestionPartition(value, job())).toBe(before);
});

it('changes question transports only for explicitly provided values that actually differ', () => {
  const decider: JevDecider = async (_key, _state, questions) => answers(questions);
  const fetcher: typeof fetch = (url, options) => fetch(url, options);
  const current = { apiKey: 'current-key', fetcher, decider };
  expect(questionTransportChanged(current, {})).toBe(false);
  expect(questionTransportChanged(current, { ...current })).toBe(false);
  expect(questionTransportChanged(current, { apiKey: current.apiKey })).toBe(false);
  expect(questionTransportChanged(current, { fetcher })).toBe(false);
  expect(questionTransportChanged(current, { decider })).toBe(false);
  expect(questionTransportChanged(current, { apiKey: 'changed-key' })).toBe(true);
  expect(questionTransportChanged(current, { fetcher: fetch })).toBe(true);
  expect(questionTransportChanged(current, { decider: async (_key, _state, questions) => answers(questions) })).toBe(true);
  expect(questionTransportChanged(current, { apiKey: undefined })).toBe(true);
  expect(questionTransportChanged(current, { fetcher: undefined })).toBe(true);
  expect(questionTransportChanged(current, { decider: undefined })).toBe(true);
  expect(questionTransportChanged({}, { apiKey: undefined, fetcher: undefined, decider: undefined })).toBe(false);
  expect(questionTransportChanged(current, Object.create({ apiKey: 'inherited-key', fetcher: fetch, decider: undefined }))).toBe(false);
});

it('bounds prefetch to explicit external profile selections with one through eight sources', () => {
  const value = context();
  expect(shouldPrefetchQuestions(value, request)).toBe(true);
  expect(shouldPrefetchQuestions(value, { ...request, blockIds: Array.from({ length: 8 }, (_, index) => String(index)) })).toBe(true);
  expect(shouldPrefetchQuestions(value, { ...request, blockIds: Array.from({ length: 9 }, (_, index) => String(index)) })).toBe(false);
  expect(shouldPrefetchQuestions(value, { ...request, action: 'label' })).toBe(false);
  expect(shouldPrefetchQuestions(value, { ...request, blockIds: undefined })).toBe(false);
  expect(shouldPrefetchQuestions(value, { ...request, blockIds: [] })).toBe(false);
  value.settings.externalProcessing = false; expect(shouldPrefetchQuestions(value, request)).toBe(false);
});

it('wraps the current checked transport while preserving context and keeping a default transport fallback', async () => {
  const value = context(); let calls = 0;
  value.decider = async (_key, _state, questions) => { calls += 1; return answers(questions); };
  const cache = new QuestionAnswerCache(); const cached = cachedQuestionContext(value, cache, 'partition');
  const questions: Record<string, JevQuestion> = { supported: { type: 'noul', instructions: 'Read the exact supplied evidence.' } };
  await cached.decider!('key', { exact: 'Evidence' }, questions); await cached.decider!('key', { exact: 'Evidence' }, questions);
  expect(calls).toBe(1); expect(cached.documents).toBe(value.documents); expect(value.decider).not.toBe(cached.decider);
  delete value.decider; expect(cachedQuestionContext(value, cache, 'default').decider).toEqual(expect.any(Function));
});

it('returns only the primary action and records a later optional read failure without completing that durable action', async () => {
  const value = primaryAndHome(); const failure = new Error('Optional home evidence unavailable');
  value.decider = async (_key, _state, questions) => {
    if (Object.keys(questions).some(id => id.replace(/^(?:\d+__)+/, '') === 'evidence')) throw failure;
    return answers(questions);
  };
  const result = await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'optional-failure');
  expect(result.proposals).toHaveLength(1); expect(result.proposals[0].action).toBe('profile');
  expect(result.result.prefetchDeferredActions).toEqual(['suggest_home_canvas']);
});

it('propagates primary provider failure after settling its optional reads', async () => {
  const value = context(); const failure = new Error('Primary native transport failure');
  value.decider = async () => { throw failure; };
  await expect(evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'primary-failure')).rejects.toBe(failure);
});

it('drains an already started optional dependent read before surfacing cancellation', async () => {
  const value = primaryAndHome(); const controller = new AbortController(); value.signal = controller.signal;
  let release!: () => void; let reached!: () => void; let settled = false;
  const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { reached = resolve; });
  const transport: JevDecider = async (_key, _state, questions) => {
    if (Object.keys(questions).some(id => id.replace(/^(?:\d+__)+/, '') === 'evidence')) { reached(); await held; }
    return answers(questions);
  };
  value.decider = transport;
  const evaluating = evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'cancel-drain');
  const outcome = evaluating.then(() => undefined, error => { settled = true; return error; });
  await started; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
  release(); expect(await outcome).toMatchObject({ status: 499 });
});

it('does not schedule disabled optional reads and never exposes their speculative proposals', async () => {
  const value = context();
  for (const action of jevActions) value.settings.modes[action] = 'off';
  value.settings.modes.profile = 'auto';
  value.decider = async (_key, _state, questions) => answers(questions);
  const result = await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'primary-only');
  expect(result.proposals.map(proposal => proposal.action)).toEqual(['profile']);
  expect(result.result.prefetchDeferredActions).toBeUndefined();
});

it('defers enabled filing questions until labels and links have been applied', async () => {
  const value = context();
  for (const action of jevActions) value.settings.modes[action] = 'off';
  value.settings.modes.profile = 'auto'; value.settings.modes.file = 'auto';
  const observed: string[] = [];
  value.decider = async (_key, _state, questions) => {
    observed.push(...Object.keys(questions).map(id => id.replace(/^(?:\d+__)+/, '')));
    return answers(questions);
  };
  await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'deferred-filing');
  expect(observed).toEqual(['role', 'keyPassage', 'logicalTopic_0', 'logicalTopicEvidence_0']);
});

it('evaluates all independent enabled reads without publishing their speculative proposals', async () => {
  const value = context(); const before = structuredClone(value);
  value.decider = async (_key, _state, questions) => answers(questions);
  const result = await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'all-independent');
  expect(result.proposals.map(proposal => proposal.action)).toEqual(['profile']);
  expect(result.result.prefetchDeferredActions).toBeUndefined();
  expect(value.documents).toEqual(before.documents); expect(value.vocabulary).toEqual(before.vocabulary);
});

it('ignores removed historical modes without asking their questions', async () => {
  const value = context();
  for (const action of jevActions) value.settings.modes[action] = 'off';
  value.settings.modes.profile = 'auto';
  Object.assign(value.settings.modes, { vocab_lifecycle: 'auto', score_quality: 'auto', flag_conflict: 'auto',
    recheck_links: 'auto', attach_doc_to_task: 'auto', assign_owner: 'auto', recall: 'auto' });
  const observed: string[] = [];
  value.decider = async (_key, _state, questions) => {
    observed.push(...Object.keys(questions).map(id => id.replace(/^(?:\d+__)+/, '')));
    return answers(questions);
  };
  const result = await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'historical-modes');
  expect(observed).toEqual(['role', 'keyPassage', 'logicalTopic_0', 'logicalTopicEvidence_0']);
  expect(result.proposals.map(proposal => proposal.action)).toEqual(['profile']);
  expect(result.result.prefetchDeferredActions).toBeUndefined();
});

it('prefetches labels only from existing checked vocabulary without creating speculative terms', async () => {
  const value = context();
  for (const action of jevActions) value.settings.modes[action] = 'off';
  value.settings.modes.profile = 'auto'; value.settings.modes.label = 'auto';
  value.vocabulary = [{ id: 'existing', kind: 'label', name: 'Evidence', definition: 'Checked evidence.',
    aliases: [], state: 'active', version: 1, members: [] }];
  const before = structuredClone(value.vocabulary); const observed: string[] = [];
  value.decider = async (_key, _state, questions) => {
    observed.push(...Object.keys(questions).map(id => id.replace(/^(?:\d+__)+/, '')));
    return answers(questions);
  };
  const result = await evaluateWithQuestionPrefetch(value, request, new QuestionAnswerCache(), 'existing-label');
  expect(observed).toContain('label_0');
  expect(value.vocabulary).toEqual(before);
  expect(result.proposals.map(proposal => proposal.action)).toEqual(['profile']);
});
