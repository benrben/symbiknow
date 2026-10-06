import { attachDocToTask } from './work.js';
import { automaticRecall, automaticVocabulary } from './automatic.js';
import { recheckLinks } from './graph.js';
import { describe, expect, it } from 'vitest';
import type { CanvasTask } from '../../../shared/types.js';
import { jevActions, type JevActionRequest, type JevVocabularyTerm } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';
import type { JevAnswer, JevQuestion } from '../../jev.js';
import { evaluateJevAction, type JevEvaluationContext, type JevInputDocument } from '../actions.js';
import { mergeAssessmentSet, mergeAssessedTerms, vocabularyLifecycle } from './vocabulary.js';
import { recall } from './serving.js';

type DecisionRule = (id: string, question: JevQuestion, state: Record<string, unknown>) => string | number | undefined;
function document(canvasId: string, id: string, content = 'Atlas requirements.\n- [ ] Enable pilot.') : JevInputDocument {
  return { canvasId, snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: `inc_${id}`,
    sourceGeneration: 1, metadataRevision: 1, contentHash: `hash_${id}` },
  block: { id, title: 'Atlas', file: `${id}.md`, content, kind: 'markdown', x: 0, y: 0, width: 1, height: 1, links: [] } };
}
function task(id: string): CanvasTask {
  return { id, title: `Atlas ${id}`, detail: '- [ ] Enable pilot.', status: 'todo', blockIds: [], comments: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', createdBy: 'user', updatedBy: 'user' };
}
function answer(id: string, question: JevQuestion, state: Record<string, unknown>, rule: DecisionRule): JevAnswer {
  const batch = /^(\d+)__(.*)$/.exec(id);
  const questionState = batch ? (state.questionSets as Record<string, unknown>[])[Number(batch[1])] : state;
  const value = rule(batch?.[2] ?? id, question, questionState);
  if (question.type === 'noul') return { type: 'noul', noul: Number(value ?? 0.98) };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const chosen = String(value ?? keys[0]);
  const probabilities = Object.fromEntries(keys.map(key => [key, key === chosen ? 1 : 0]));
  if (question.type === 'choice') return { type: 'choice', choice: chosen, confidence: 1, probabilities };
  return { type: 'score', score: Number(chosen), confidence: 1, probabilities };
}
function context(rule: DecisionRule = () => undefined): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [document('canvas', 'one'), document('canvas', 'two'), document('other', 'three')],
    canvases: [{ id: 'canvas', name: 'Atlas' }, { id: 'other', name: 'Delivery' }], tasks: [{ canvasId: 'canvas', task: task('pilot') }],
    vocabulary: [], apiKey: 'fixture', now: new Date('2026-10-03T12:00:00Z'),
    settings: { paused: false, externalProcessing: true, people: [{ id: 'maya', name: 'Maya', role: 'Owner' }], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'suggest'])) as JevEvaluationContext['settings']['modes'] },
    decider: async (_key, state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) =>
      [id, answer(id, question, state as Record<string, unknown>, rule)])) };
}
function request(action: JevActionRequest['action'], options: JevActionRequest['options'] = {}): JevActionRequest {
  return { action, canvasId: 'canvas', blockIds: ['one'], options };
}
function term(kind: JevVocabularyTerm['kind'], name: string): JevVocabularyTerm {
  return { id: name, kind, name, definition: name, aliases: [], state: 'active', version: 1,
    members: [{ canvasId: 'canvas', blockId: 'one' }] };
}

describe('Symbi Reflex uncertainty, idempotency, and incomplete evidence boundaries', () => {
  it('keeps missing vocabulary and unsupported metadata outcomes explicit', async () => {
    const input = context(id => id === 'role' ? 'unknown' : id === 'flag' ? 0.05 : undefined);
    expect((await evaluateJevAction(input, request('profile'))).result.documents).toMatchObject({ one: { role: 'unknown' } });
    expect((await evaluateJevAction(input, request('file'))).proposals).toHaveLength(2);
    expect((await evaluateJevAction(input, request('label'))).result.status).toBe('missing_label_vocabulary');
    input.documents[0].block.tags = ['atlas'];
    const unchanged = await evaluateJevAction(input, request('label'));
    expect(unchanged.proposals).toEqual([]);
  });

  it('extracts manual group definitions with native keys', async () => {
    const input = context();
    input.canvases[0].groups = [{ id: 'custom:planning', name: 'Planning' }];
    const filed = await evaluateJevAction(input, request('file'));
    expect(filed.proposals[0].mutation).toMatchObject({ patch: { group: 'custom:planning' } });
    input.vocabulary.push(term('group', 'תכנון'));
    input.canvases[0].groups = [];
    const unicode = await evaluateJevAction(input, request('file'));
    expect(unicode.proposals[0].mutation).toMatchObject({ patch: { group: expect.stringMatching(/^custom:[a-f0-9]{16}$/) } });
  });

  it('preserves a supported current home', async () => {
    const input = context();
    expect((await evaluateJevAction(input, request('suggest_home_canvas'))).proposals).toEqual([]);
  });

  it('does not rewrite identical edges and deduplicates symmetric pair findings', async () => {
    const input = context();
    input.documents = input.documents.slice(0, 2);
    input.documents[0].block.links = ['two'];
    input.documents[0].block.linkTypes = { two: 'related' };
    input.decider = context((_id, question) => question.type === 'score' ? 2 : undefined).decider;
    expect((await evaluateJevAction(input, request('link'))).proposals).toEqual([]);
    expect((await evaluateJevAction(input, { action: 'flag_duplicate', canvasId: 'canvas' })).proposals).toHaveLength(1);
    await expect(evaluateJevAction(input, request('link', { relation: 'invented' }))).rejects.toMatchObject({ status: 400 });
    input.decider = context(id => id === 'supported' ? 0.5 : undefined).decider;
    expect((await recheckLinks(input, request('recheck_links'))).result.edges).toMatchObject([{ status: 'insufficient_evidence' }]);
  });

  it('checks an automatic link type in the same provider round and omits duplicate usefulness scoring', async () => {
    const input = context(id => id === 'relation' ? 'implements' : id === 'usefulness' ? 2 : undefined);
    input.documents = input.documents.slice(0, 2);
    const questionSets: string[][] = [];
    const original = input.decider!;
    input.decider = async (...args) => {
      questionSets.push(Object.keys(args[2]));
      return original(...args);
    };
    const linked = await evaluateJevAction(input, request('link'));
    expect(linked.proposals[0].mutation).toMatchObject({ patch: { linkTypes: { two: 'implements' } } });
    expect(questionSets.flat().some(id => id.endsWith('relation'))).toBe(true);
    input.documents[1].block.content = 'Atlas requirements.\n- [ ] Ship the pilot with a separate approval.';
    questionSets.length = 0;
    await evaluateJevAction(input, request('flag_duplicate'));
    expect(questionSets.flat().some(id => id.endsWith('usefulness'))).toBe(false);
  });

  it('finds exact duplicate bytes without a provider call but leaves a distinct update to evidence review', async () => {
    const input = context(); input.documents = input.documents.slice(0, 2);
    input.decider = async () => { throw new Error('Exact duplicate should not request inference'); };
    const exact = await evaluateJevAction(input, request('flag_duplicate'));
    expect(exact.result.findings).toMatchObject([{ method: 'exact_content', confidence: 1 }]);
    expect(exact.proposals[0].evidence.map(item => item.source.blockId)).toEqual(['one', 'two']);
    input.documents[1].block.content += '\nNew evidence extends the release plan.';
    input.decider = context(id => id === 'supported' ? .02 : undefined).decider;
    const update = await evaluateJevAction(input, request('flag_duplicate'));
    expect(update.proposals).toEqual([]);
    expect(update.result.reason).toBe('No candidate pair met duplicate evidence');
  });

  it('updates existing cross-canvas endpoints without losing other endpoints', async () => {
    const input = context((_id, question) => question.type === 'score' ? 2 : undefined);
    input.documents[0].block.crossLinks = [{ canvasId: 'other', blockId: 'three', relation: 'related' },
      { canvasId: 'other', blockId: 'unavailable', relation: 'related' }, { canvasId: 'elsewhere', blockId: 'three', relation: 'related' }];
    const linked = await evaluateJevAction(input, request('link', { relation: 'implements' }));
    expect(linked.proposals[0].mutation).toMatchObject({ patch: { crossLinks: expect.arrayContaining([
      { canvasId: 'other', blockId: 'unavailable', relation: 'related' }, { canvasId: 'elsewhere', blockId: 'three', relation: 'related' }]) } });
    input.documents[0].block.jevOwnership = { managed: ['link:other:three'], pins: [], removedLabels: [], removedLinks: [] };
    input.documents[0].block.crossLinks[0].relation = undefined;
    input.decider = context(id => id === 'supported' ? 0.01 : undefined).decider;
    const removed = await recheckLinks(input, request('recheck_links'));
    expect(removed.proposals[1].mutation).toMatchObject({ patch: { crossLinks: expect.arrayContaining([{ canvasId: 'other', blockId: 'unavailable', relation: 'related' }]) } });
  });

  it('keeps local recall honest and propagates cancellation and unexpected errors', async () => {
    const input = context(id => id === 'relevance' || id === 'conflict' ? 0.1 : undefined);
    expect((await automaticRecall(input, request('recall'))).result.status).toBe('support_checked');
    expect((await automaticRecall(input, { ...request('recall'), query: 'Atlas' })).result.evidenceStatus).toBe('no_verified_support');
    input.decider = async () => { throw new ApiError(499, 'Cancelled'); };
    await expect(automaticRecall(input, { ...request('recall'), query: 'Atlas' })).rejects.toMatchObject({ status: 499 });
    const error = new Error('Adapter defect');
    input.decider = async () => { throw error; };
    await expect(automaticRecall(input, { ...request('recall'), query: 'Atlas' })).rejects.toBe(error);
  });

  it('distinguishes new, existing, and insufficiently supported vocabulary concepts', async () => {
    const input = context();
    input.documents[0].block.content = '# Atlas\nDelivery rules';
    const defined = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'define' }));
    expect(defined.proposals[0].mutation).toMatchObject({ term: { name: 'Atlas', state: 'active' } });
    input.vocabulary = [term('label', 'Atlas')];
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { name: 'Atlas' }))).result.status).toBe('existing_concept');
    input.decider = context(id => id === 'fit' ? 0.1 : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { name: 'New concept' }))).result.status).toBe('insufficient_concept_evidence');
    input.decider = context(id => id === 'concept' ? 'none' : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { name: 'New concept' }))).result.status).toBe('insufficient_concept_evidence');
    input.documents = input.documents.slice(0, 1); input.documents[0].block.title = ''; input.documents[0].block.content = '';
    expect((await automaticVocabulary(input, request('vocab_lifecycle'))).result.status).toBe('no_change');
  });

  it('keeps text-derived vocabulary nominations inactive until the checked automatic definition flow promotes them', async () => {
    const input = context(); input.documents = input.documents.slice(0, 1);
    input.documents[0].block.content = '# Atlas\nAtlas requirements.';
    const nominated = await vocabularyLifecycle(input, request('vocab_lifecycle'));
    expect(nominated.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', operation: 'define', term: {
      name: 'Atlas', definition: '# Atlas', state: 'candidate', members: [{ canvasId: 'canvas', blockId: 'one' }] } });
    const defined = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'define', name: 'Atlas', definition: 'Atlas requirements.' }));
    expect(defined.proposals[0].mutation).toMatchObject({ term: { state: 'active', definition: 'Atlas requirements.' } });
    input.documents[0].block.title = ''; input.documents[0].block.content = '';
    expect(await vocabularyLifecycle(input, request('vocab_lifecycle', { operation: 'nominate' }))).toEqual({
      result: { status: 'no_text_derived_names' }, proposals: [] });
  });

  it('returns no recall evidence for a missing or blank query before consulting a provider', async () => {
    const input = context(); input.decider = async () => { throw new Error('Empty recall query reached provider'); };
    for (const query of [undefined, ' \n ']) {
      expect(await recall(input, { ...request('recall'), query })).toEqual({ result: { status: 'missing_query', passages: [], conflicts: [] }, proposals: [] });
    }
  });

  it('migrates only matching label memberships and never writes document fields for entities', async () => {
    const input = context();
    input.vocabulary = [term('entity', 'Atlas'), term('label', 'atlas')];
    const entity = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'Atlas', name: 'Atlas App' }));
    expect(entity.proposals).toHaveLength(1);
    const absent = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'atlas', name: 'delivery' }));
    expect(absent.proposals[1].mutation).toMatchObject({ patch: { tags: [] } });
    input.documents[0].block.tags = ['atlas', 'manual'];
    const migrated = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'atlas', name: 'delivery' }));
    expect(migrated.proposals[1].mutation).toMatchObject({ patch: { tags: ['delivery', 'manual'] } });
  });

  it.each(['same term', 'different kinds'])('revalidates an assessed merge before consuming synonymy when the pair now has %s', invalidPair => {
    const input = context(); input.vocabulary = [term('label', 'Atlas'), term('label', 'Release')];
    const mergeRequest = request('vocab_lifecycle', { operation: 'merge', termId: 'Atlas', targetId: 'Release' });
    expect(mergeAssessmentSet(input, mergeRequest).state).toMatchObject({ sourceName: 'Atlas', targetName: 'Release' });
    if (invalidPair === 'same term') mergeRequest.options!.targetId = 'Atlas';
    else input.vocabulary[1].kind = 'entity';
    const before = structuredClone({ documents: input.documents, vocabulary: input.vocabulary });
    expect(() => mergeAssessedTerms(input, mergeRequest, { type: 'noul', noul: 1 }))
      .toThrowError(expect.objectContaining({ status: 400, message: 'Merge requires two distinct terms of the same kind' }));
    expect({ documents: input.documents, vocabulary: input.vocabulary }).toEqual(before);
  });

  it('keeps existing task attachments idempotent and rejects unsupported attachments', async () => {
    const input = context();
    input.tasks[0].task.blockIds = ['one'];
    expect((await attachDocToTask(input, request('attach_doc_to_task'))).proposals).toEqual([]);
    input.tasks[0].task.blockIds = [];
    input.decider = context(id => id === 'matches' ? 0.1 : undefined).decider;
    expect((await attachDocToTask(input, request('attach_doc_to_task'))).proposals).toEqual([]);
  });

  it('retains supported existing connections', async () => {
    const input = context();
    input.documents[0].block.links = ['two'];
    const rechecked = await recheckLinks(input, request('recheck_links'));
    expect(rechecked.result.edges).toMatchObject([{ status: 'fresh' }]);
  });

  it('adds an activated label to untagged sources', async () => {
    const input = context();
    input.vocabulary = [term('label', 'atlas')];
    expect((await evaluateJevAction(input, request('label'))).proposals[0].mutation).toMatchObject({ patch: { tags: ['atlas'] } });
  });

  it('rejects malformed selectors instead of widening document or task operations', async () => {
    const invalid: JevActionRequest[] = [request('assign_owner', { subaction: 'assign_reviwer' }),
      request('attach_doc_to_task', { taskId: 125 }), request('vocab_lifecycle', { aliases: ['valid', 1] }),
      request('recall', { includeArchived: 'yes' })];
    const input = context();
    input.decider = async () => { throw new Error('Invalid options reached external inference'); };
    for (const request of invalid) await expect(evaluateJevAction(input, request)).rejects.toMatchObject({ status: 400 });
  });

  it('bootstraps groups only from supported topics and respects active, candidate, and retired definitions', async () => {
    const selectNewOnly: DecisionRule = (id, question) => {
      if (id !== 'group' || question.type !== 'choice') return undefined;
      if ('g0' in question.criteria) return 'none';
      return Object.keys(question.criteria).find(key => question.criteria[key].includes('(custom:atlas/rollout)'));
    };
    const input = context(selectNewOnly);
    input.documents = input.documents.slice(0, 2);
    input.documents.forEach(document => { document.block.content = '# Atlas\n## Rollout\nWork to ship Atlas.'; });
    const parent = { ...term('group', 'Atlas'), groupKey: 'custom:atlas', members: [] };
    input.vocabulary = [parent];
    const active = await evaluateJevAction(input, request('file'));
    expect(active.proposals.filter(proposal => proposal.mutation.kind === 'vocabulary')).toHaveLength(1);
    input.vocabulary[0].state = 'candidate';
    expect((await evaluateJevAction(input, request('file'))).proposals[0].mutation).toMatchObject({ operation: 'promote' });
    input.vocabulary[0].state = 'retired';
    expect((await evaluateJevAction(input, request('file'))).result.status).toBe('retired_group_requires_restore');
    input.vocabulary[0].state = 'active';
    input.vocabulary.push({ ...term('group', 'Atlas / Rollout'), groupKey: 'custom:atlas/rollout', parentId: parent.id, state: 'retired' });
    expect((await evaluateJevAction(input, request('file'))).proposals).toEqual([]);
    input.vocabulary[1].state = 'candidate';
    expect((await evaluateJevAction(input, request('file'))).proposals[0].mutation).toMatchObject({ operation: 'promote' });
    input.vocabulary = []; input.documents = input.documents.slice(0, 1); input.documents[0].block.content = '## An orphan heading';
    expect((await evaluateJevAction(input, request('file'))).proposals[0].mutation).toMatchObject({ operation: 'define' });
    input.documents[0].block.title = ''; input.documents[0].block.content = '';
    expect((await evaluateJevAction(input, request('file'))).result.status).toBe('no_source_derived_group_names');
  });

  it('validates subgroup parents and explicit native paths before proposing hierarchy changes', async () => {
    const input = context();
    const parent = { ...term('group', 'Atlas'), groupKey: 'custom:atlas' };
    input.vocabulary = [parent];
    const options = { operation: 'define', kind: 'group', name: 'Pilot' };
    const root = await automaticVocabulary(input, request('vocab_lifecycle', { ...options, groupKey: 'custom:pilot' }));
    expect(root.proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:pilot' } });
    const child = await automaticVocabulary(input, request('vocab_lifecycle', { ...options, groupKey: 'custom:atlas/pilot' }));
    expect(child.proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas/pilot', parentId: parent.id } });
    const invalidFields: NonNullable<JevActionRequest['options']>[] = [{ groupKey: 'invalid:path' }, { parentId: 'missing' }, { groupKey: 'custom:missing/pilot' },
      { parentId: parent.id, groupKey: 'custom:other/pilot' }];
    for (const fields of invalidFields) {
      await expect(automaticVocabulary(input, request('vocab_lifecycle', { ...options, ...fields }))).rejects.toMatchObject({ status: expect.any(Number) });
    }
    input.vocabulary[0].state = 'retired';
    await expect(automaticVocabulary(input, request('vocab_lifecycle', { ...options, parentId: parent.id }))).rejects.toMatchObject({ status: 409 });
    input.vocabulary = [];
    expect((await automaticVocabulary(input, request('vocab_lifecycle', options))).proposals[0].mutation)
      .toMatchObject({ term: { groupKey: 'custom:pilot' } });
    input.vocabulary = [{ ...parent, state: 'active', groupKey: 'custom:a/b/c/d/e/f/g/h' }];
    await expect(automaticVocabulary(input, request('vocab_lifecycle', { ...options, parentId: parent.id }))).rejects.toMatchObject({ status: 400 });
  });

  it('does not infer containment without an explicit supported parent and exact passage', async () => {
    const input = context(id => id === 'parent' || id === 'parentEvidence' ? 'none' : undefined);
    input.vocabulary = [{ ...term('group', 'Atlas'), groupKey: 'custom:atlas' }];
    const options = { operation: 'define', kind: 'group', name: 'Pilot' };
    expect((await automaticVocabulary(input, request('vocab_lifecycle', options))).proposals[0].mutation)
      .toMatchObject({ term: { groupKey: 'custom:pilot' } });
    input.decider = context(id => id === 'containment' ? 0.01 : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle', options))).proposals[0].mutation)
      .toMatchObject({ term: { groupKey: 'custom:pilot' } });
    input.decider = context(id => id === 'parentEvidence' ? 'none' : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle', options))).proposals[0].mutation)
      .toMatchObject({ term: { groupKey: 'custom:pilot' } });
  });

  it('preserves subgroup paths through split and multi-level parent migrations', async () => {
    const input = context();
    input.vocabulary = [{ ...term('group', 'Atlas'), groupKey: 'custom:atlas' },
      { ...term('group', 'Pilot'), groupKey: 'custom:atlas/pilot', parentId: 'Atlas' },
      { ...term('group', 'Checklist'), groupKey: 'custom:atlas/pilot/checklist', parentId: 'Pilot' }];
    input.documents[0].block.group = 'custom:atlas/pilot/checklist';
    const renamed = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'Atlas', name: 'Release' }));
    expect(renamed.proposals.some(proposal => proposal.mutation.kind === 'document' && proposal.mutation.patch.group === 'custom:release/pilot/checklist')).toBe(true);
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'Atlas', name: 'Atlas' }))).proposals).toHaveLength(1);
    const split = await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'split', termId: 'Pilot', splitNames: ['Setup', 'Verification'] }));
    expect(split.proposals.some(proposal => proposal.mutation.kind === 'vocabulary' && proposal.mutation.term.groupKey === 'custom:atlas/setup')).toBe(true);
  });

  it('retains independent semantic bootstrap confidence without treating quote selection as a write certificate', async () => {
    const input = context();
    input.settings.modes.file = 'auto';
    const automatic = await evaluateJevAction(input, request('file'));
    expect(automatic.proposals.every(proposal => JSON.stringify(proposal.decisionConfidences) === '[1,0.98,0.98]')).toBe(true);
    input.decider = context(id => id === 'coherent' ? 0.85 : undefined).decider;
    const uncertain = await evaluateJevAction(input, request('file'));
    expect(uncertain.proposals.every(proposal => JSON.stringify(proposal.decisionConfidences) === '[1,0.85,0.98]')).toBe(true);
  });
});
