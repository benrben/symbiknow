import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevActionRequest, JevVocabularyTerm } from '../../../shared/jev-types.js';
import { decideWithJev, type JevAnswer, type JevQuestion } from '../../jev.js';
import { CanvasStore } from '../../storage.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import { cachedQuestionContext } from '../runtime-question-prefetch.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { filingPassages } from './group-passages.js';
import { bootstrapGrouping } from './grouping.js';
import { file } from './profile.js';
import { QuestionAnswerCache } from './question-answer-cache.js';

type Body = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
let provider: Server; let origin: string; let root: string; let store: CanvasStore;
let input: JevEvaluationContext; let document: JevInputDocument; let request: JevActionRequest;
let manyGroups: JevInputDocument; let preferredGroup: string;
let transform: (id: string, answer: JevAnswer, state: Record<string, unknown>, question: JevQuestion) => JevAnswer;
const calls: Body[] = [];
const content = '# Engineering\nEngineering defines checked API boundaries.\n## Backend\nPurpose: Engineering / Backend. Define service contracts and persistence.';
function questionInput(body: Body, wireId: string) {
  let state = body.state; let id = wireId; let match = /^(\d+)__(.+)$/.exec(id);
  while (match) { state = (state.questionSets as Record<string, unknown>[])[Number(match[1])]; id = match[2]; match = /^(\d+)__(.+)$/.exec(id); }
  return { state, id };
}
function answer(body: Body, wireId: string, question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: .98 };
  if (question.type !== 'choice') throw new Error('Unexpected grouping question type');
  const { id } = questionInput(body, wireId); const keys = Object.keys(question.criteria);
  const selected = id === 'group' ? keys.find(key => question.criteria[key].includes(`(${preferredGroup})`)) ?? keys[0]
    : keys.find(key => question.criteria[key].includes('Purpose: Engineering / Backend.')) ?? keys[0];
  return { type: 'choice', choice: selected, confidence: .98,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}
beforeAll(async () => {
  provider = createServer(async (incoming, response) => {
    let raw = ''; for await (const chunk of incoming) raw += String(chunk);
    const body = JSON.parse(raw) as Body; calls.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions)
      .map(([id, question]) => {
        const local = questionInput(body, id);
        return [id, transform(local.id, answer(body, id, question), local.state, question)];
      })) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Native group provider did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'jev-group-flow-'));
  store = new CanvasStore(root); await store.init();
  const workspaceId = (await store.createWorkspace({ name: 'Native grouped evidence' })).id;
  const canvasId = (await store.createCanvas(workspaceId, { name: 'Engineering' })).id;
  const block = await store.createBlock(canvasId, { title: 'Engineering', content, x: 123, y: 456 });
  await store.createBlock(canvasId, { title: 'Backend reference', content: '# Engineering\n## Backend\nEngineering / Backend defines persistent API contracts.' });
  await store.ensureJevStamps(canvasId);
  const canvas = await store.getCanvas(canvasId);
  const documents = canvas.blocks.map(item => ({ canvasId, block: item, snapshot: sourceSnapshot(workspaceId, canvasId, item) }));
  document = documents.find(item => item.block.id === block.id)!;
  input = { workspaceId, documents, canvases: [{ id: canvasId, name: 'Engineering' }], tasks: [], vocabulary: [],
    settings: emptyJevWorkspace().settings, apiKey: 'native-group-flow',
    decider: (key, state, questions, _fetcher, options) => decideWithJev(key, state, questions, (_url, init) => fetch(origin, init), options) };
  request = { action: 'file', canvasId, blockIds: [block.id] };
  const otherCanvas = (await store.createCanvas(workspaceId, { name: 'Four local subjects' })).id;
  const other = await store.createBlock(otherCanvas, { title: 'Engineering',
    content: '# Engineering\nEngineering defines API boundaries.\n# Operations\nOperations plans deployments.\n# Knowledge\nKnowledge records evidence.\n# Planning\nPlanning records delivery.' });
  await store.ensureJevStamps(otherCanvas);
  const saved = await store.getCanvasBlock(otherCanvas, other.id);
  manyGroups = { canvasId: otherCanvas, block: saved, snapshot: sourceSnapshot(workspaceId, otherCanvas, saved) };
});
beforeEach(async () => {
  calls.splice(0); preferredGroup = 'custom:engineering'; transform = (_id, answer) => answer;
  const canvas = await store.getCanvas(request.canvasId);
  input.documents = canvas.blocks.map(block => ({ canvasId: canvas.id, block, snapshot: sourceSnapshot(input.workspaceId, canvas.id, block) }));
  document = input.documents.find(item => item.block.id === request.blockIds![0])!;
});
afterAll(async () => {
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

it('combines independent bootstrap selection and exact local assessments into one bounded SDK wave', async () => {
  const evaluated = await bootstrapGrouping(input, request, document);
  expect(evaluated.result.status).toBe('proposed_grouping');
  const membership = evaluated.proposals.find(item => item.mutation.kind === 'document')!;
  expect(membership.mutation).toMatchObject({ kind: 'document', patch: { group: 'custom:engineering' } });
  const selected = filingPassages(document).find(passage => passage.quote.includes('Purpose: Engineering / Backend.'))!;
  expect(membership.evidence).toEqual([selected]);
  expect(membership.sources).toEqual([document.snapshot]);
  expect(document.block.content.slice(selected.start, selected.end)).toBe(selected.quote);
  expect(await new CanvasStore(root).getCanvasBlock(request.canvasId, document.block.id)).toMatchObject({ content, x: 123, y: 456 });
  expect(calls).toHaveLength(1);
});

it('refuses the selected unsupported passage even when every other local passage is supported', async () => {
  const index = filingPassages(document).findIndex(passage => passage.quote.includes('Purpose: Engineering / Backend.'));
  transform = (id, answer) => id === `purpose_${index}` ? { type: 'noul', noul: .69 } : answer;
  const result = await bootstrapGrouping(input, request, document);
  expect(result).toMatchObject({ result: { status: 'insufficient_local_group_purpose' }, proposals: [] });
  const purposes = calls.flatMap(body => Object.entries(body.questions).filter(([id]) => questionInput(body, id).id.startsWith('purpose_')));
  expect(purposes.length).toBeGreaterThan(2);
  for (const [, question] of purposes) expect(question.instructions).toMatch(/Use only localEvidence\[\d+\]/);
  expect(calls.slice(1).every(body => Object.keys(body.questions).join() === 'group')).toBe(true);
});

it.each([false, true])('uses containment of only the selected exact passage for a nested group (supported=%s)', async supported => {
  preferredGroup = 'custom:engineering/backend';
  const index = filingPassages(document).findIndex(passage => passage.quote.includes('Purpose: Engineering / Backend.'));
  transform = (id, answer) => id.startsWith('containment_') ? { type: 'noul', noul: (id === `containment_${index}`) === supported ? .98 : .1 } : answer;
  const result = await bootstrapGrouping(input, request, document, ['custom:engineering']);
  if (!supported) expect(result).toMatchObject({ result: { status: 'insufficient_local_group_purpose' }, proposals: [] });
  else {
    expect(result.proposals.find(item => item.mutation.kind === 'document')!.mutation).toMatchObject({ patch: { group: preferredGroup } });
    for (const item of result.proposals) expect(item.decisionConfidences).toEqual([.98, .98, .98, .98]);
  }
  expect(calls).toHaveLength(1);
});

it.each([.65, .85, undefined])('applies the configured semantic threshold without borrowing a different passage confidence (%s)', async confidenceThreshold => {
  transform = (id, answer) => id.startsWith('purpose_') ? { type: 'noul', noul: .75 } : answer;
  const result = await bootstrapGrouping({ ...input, confidenceThreshold }, request, document);
  if (confidenceThreshold === .85) expect(result.proposals).toEqual([]);
  else {
    expect(result.result.status).toBe('proposed_grouping');
    expect(result.proposals.every(item => item.decisionConfidences?.includes(.75))).toBe(true);
  }
});

it('reasks only selection after rejecting one candidate and reuses the supported nested candidate assessment', async () => {
  transform = (id, answer, state) => id === 'coherent' && (state.selectedGroup as { key: string }).key === 'custom:engineering'
    ? { type: 'noul', noul: .1 } : answer;
  const result = await bootstrapGrouping(input, request, document);
  expect(result.proposals.find(item => item.mutation.kind === 'document')!.mutation).toMatchObject({ patch: { group: 'custom:engineering/backend' } });
  expect(calls).toHaveLength(2); expect(Object.keys(calls[1].questions)).toEqual(['group']);
  expect((calls[1].state.proposedGroups as Array<{ key: string }>).map(group => group.key)).toEqual(['custom:engineering/backend']);
});

it('bounds failed fallback to three selections while every candidate is assessed only once', async () => {
  transform = (id, answer) => id === 'coherent' ? { type: 'noul', noul: .1 } : answer;
  const context = { ...input, documents: [manyGroups], canvases: [{ id: manyGroups.canvasId, name: 'Four local subjects' }] };
  const result = await bootstrapGrouping(context, { ...request, canvasId: manyGroups.canvasId, blockIds: [manyGroups.block.id] }, manyGroups);
  expect(result).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  expect(calls).toHaveLength(3);
  expect(calls.slice(1).every(body => Object.keys(body.questions).join() === 'group')).toBe(true);
});

it('preserves evidence and selection abstentions without filing and keeps an empty source catalog local', async () => {
  transform = (id, answer, _state, question) => id === 'evidence' && question.type === 'choice' ? {
    type: 'choice', choice: 'none', confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'none' ? 1 : 0])),
  } : answer;
  expect(await bootstrapGrouping(input, request, document)).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  transform = (id, answer, _state, question) => id === 'group' && question.type === 'choice' ? {
    type: 'choice', choice: 'unknown', confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'unknown' ? 1 : 0])),
  } : answer;
  const count = calls.length;
  expect(await bootstrapGrouping(input, request, document)).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  expect(calls).toHaveLength(count + 1);
  const empty = { ...document, block: { ...document.block, content: '', title: '' } };
  expect(await bootstrapGrouping({ ...input, documents: [empty] }, request, empty)).toMatchObject({ result: { status: 'no_source_derived_group_names' }, proposals: [] });
  expect(calls).toHaveLength(count + 1);
});

it('reuses semantic assessments after a real metadata-only revision and emits current source guards', async () => {
  const cache = new QuestionAnswerCache();
  expect((await bootstrapGrouping(cachedQuestionContext(input, cache, 'native-group-source-policy'), request, document)).proposals.length).toBeGreaterThan(0);
  const updated = await store.jevExecutor.setOwnership(request.canvasId, document.block.id, { managed: ['profile'] });
  const fresh = { ...document, block: updated, snapshot: sourceSnapshot(input.workspaceId, request.canvasId, updated) };
  expect(fresh.snapshot.metadataRevision).toBeGreaterThan(document.snapshot.metadataRevision);
  const current = { ...input, documents: input.documents.map(item => item.block.id === fresh.block.id ? fresh : item) };
  const result = await bootstrapGrouping(cachedQuestionContext(current, cache, 'native-group-source-policy'), request, fresh);
  expect(result.proposals.find(item => item.mutation.kind === 'document')!.sources).toEqual([fresh.snapshot]);
  expect(calls).toHaveLength(1);
});

function existingGroup(key: string, state: JevVocabularyTerm['state']): JevVocabularyTerm {
  return { id: `existing-${key.replaceAll('/', '-')}`, kind: 'group', name: key.includes('/') ? 'Engineering / Backend' : 'Engineering',
    groupKey: key, definition: 'Engineering defines checked service contracts and persistence.',
    state, aliases: [], version: 3, members: [{ canvasId: document.canvasId, blockId: document.block.id }] };
}

it('promotes an existing candidate with its next version instead of creating a conflicting group definition', async () => {
  const previous = existingGroup('custom:engineering', 'candidate');
  const result = await bootstrapGrouping({ ...input, vocabulary: [previous] }, request, document);
  expect(result.proposals.find(item => item.mutation.kind === 'vocabulary')!.mutation)
    .toMatchObject({ operation: 'promote', term: { ...previous, state: 'active', version: 4 } });
  expect(result.proposals.find(item => item.mutation.kind === 'document')!.sources).toEqual([document.snapshot]);
  expect(previous.state).toBe('candidate'); expect(previous.version).toBe(3);
  expect(calls).toHaveLength(1);
});

it('retains an existing active definition and proposes only the exact guarded membership', async () => {
  const previous = existingGroup('custom:engineering', 'active');
  const result = await bootstrapGrouping({ ...input, vocabulary: [previous] }, request, document);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { group: 'custom:engineering' } });
  expect(previous.version).toBe(3); expect(calls).toHaveLength(1);
});

it.each(['root', 'parent', 'child'] as const)('refuses a retired %s without restoring it or changing membership', async retired => {
  preferredGroup = retired === 'root' ? 'custom:engineering' : 'custom:engineering/backend';
  const previous = existingGroup(retired === 'child' ? 'custom:engineering/backend' : 'custom:engineering', 'retired');
  const result = await bootstrapGrouping({ ...input, vocabulary: [previous] }, request, document);
  expect(result).toMatchObject({ result: { status: 'retired_group_requires_restore' }, proposals: [] });
  expect(previous.state).toBe('retired'); expect(calls).toHaveLength(1);
});

it('selects a group and exact evidence before checking only that selected passage in the second wave', async () => {
  const selective = { ...input, selectiveGroupAssessment: true };
  const result = await bootstrapGrouping(selective, request, document);
  expect(result.result.status).toBe('proposed_grouping');
  expect(calls).toHaveLength(2);
  expect(Object.keys(calls[0].questions).map(id => questionInput(calls[0], id).id)).toEqual(['group', 'evidence', 'evidence']);
  const index = filingPassages(document).findIndex(passage => passage.quote.includes('Purpose: Engineering / Backend.'));
  expect(Object.keys(calls[1].questions)).toEqual(['coherent', `purpose_${index}`]);
  expect(calls[1].state.selectedGroup).toMatchObject({ key: 'custom:engineering' });
  for (const candidate of result.proposals) expect(candidate.decisionConfidences).toEqual([.98, .98, .98]);
});

it.each([.65, .85])('retains selected subgroup containment at threshold %s in selective mode', async confidenceThreshold => {
  preferredGroup = 'custom:engineering/backend';
  transform = (id, answer) => id.startsWith('containment_') ? { type: 'noul', noul: .75 } : answer;
  const selective = { ...input, selectiveGroupAssessment: true, confidenceThreshold };
  const result = await bootstrapGrouping(selective, request, document, ['custom:engineering']);
  expect(calls).toHaveLength(2);
  const index = filingPassages(document).findIndex(passage => passage.quote.includes('Purpose: Engineering / Backend.'));
  expect(Object.keys(calls[1].questions)).toEqual(['coherent', `purpose_${index}`, `containment_${index}`]);
  if (confidenceThreshold > .75) expect(result).toMatchObject({ result: { status: 'insufficient_local_group_purpose' }, proposals: [] });
  else expect(result.proposals.every(candidate => candidate.decisionConfidences?.includes(.75))).toBe(true);
});

it('does not request any semantic group assessments when selective group selection abstains', async () => {
  transform = (id, answer, _state, question) => id === 'group' && question.type === 'choice' ? {
    type: 'choice', choice: 'none', confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'none')])),
  } : answer;
  const result = await bootstrapGrouping({ ...input, selectiveGroupAssessment: true }, request, document);
  expect(result).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  expect(calls).toHaveLength(1);
  expect(Object.values(calls[0].questions).every(question => question.type === 'choice')).toBe(true);
});

it('retains fallback selection while checking only each actually selected group in selective mode', async () => {
  transform = (id, answer, state) => id === 'coherent' && (state.selectedGroup as { key: string }).key === 'custom:engineering'
    ? { type: 'noul', noul: .1 } : answer;
  const result = await bootstrapGrouping({ ...input, selectiveGroupAssessment: true }, request, document);
  expect(result.proposals.find(item => item.mutation.kind === 'document')!.mutation).toMatchObject({ patch: { group: 'custom:engineering/backend' } });
  expect(calls).toHaveLength(4);
  expect(calls[1].state.selectedGroup).toMatchObject({ key: 'custom:engineering' });
  expect(Object.keys(calls[2].questions)).toEqual(['group']);
  expect(calls[3].state.selectedGroup).toMatchObject({ key: 'custom:engineering/backend' });
});

it('assesses only the selected exact evidence when reusing an existing group in selective mode', async () => {
  const previous = existingGroup('custom:engineering', 'active');
  const result = await file({ ...input, vocabulary: [previous], selectiveGroupAssessment: true }, request);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0].mutation).toMatchObject({ kind: 'document', patch: { group: 'custom:engineering' } });
  expect(calls).toHaveLength(4);
  expect(Object.keys(calls[0].questions).map(id => questionInput(calls[0], id).id)).toEqual(['place', 'gate']);
  expect(calls[1].state).toMatchObject({ currentGroup: null, baselineGroup: 'custom:engineering' });
  expect(Object.keys(calls[1].questions)).toEqual(['place', 'gate']);
  expect(Object.keys(calls[2].questions)).toEqual(['evidence']);
  expect(calls[2].state.selectedGroup).toMatchObject({ key: 'custom:engineering' });
  expect(calls.slice(0, 3).every(call => Object.values(call.questions).every(question => question.type === 'choice'))).toBe(true);
  const index = filingPassages(document).findIndex(passage => passage.quote.includes('Purpose: Engineering / Backend.'));
  expect(Object.keys(calls[3].questions)).toEqual([`purpose_${index}`]);
  expect(calls[3].state.selectedGroup).toMatchObject({ key: 'custom:engineering', definition: previous.definition });
  expect(result.proposals[0].decisionConfidences).toEqual([1, .98]);
  expect(result.proposals[0].sources).toEqual([document.snapshot]);
});

it('avoids selective semantic calls when no candidate has exact evidence', async () => {
  transform = (id, answer, _state, question) => id === 'evidence' && question.type === 'choice' ? {
    type: 'choice', choice: 'none', confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === 'none')])),
  } : answer;
  const result = await bootstrapGrouping({ ...input, selectiveGroupAssessment: true }, request, document);
  expect(result).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  expect(calls.flatMap(call => Object.values(call.questions)).every(question => question.type === 'choice')).toBe(true);
});

it('retains current existing membership without requesting a selective semantic assessment', async () => {
  const current = { ...document, block: { ...document.block, group: 'custom:engineering' } };
  const result = await file({ ...input, documents: [current], selectiveGroupAssessment: true }, request);
  expect(result.proposals).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0].questions)).toEqual(['place', 'gate']);
});

it('rejects a malformed selected semantic response without returning a grouping proposal', async () => {
  transform = (id, answer) => id.startsWith('purpose_') ? { type: 'noul', noul: 1.1 } : answer;
  await expect(bootstrapGrouping({ ...input, selectiveGroupAssessment: true }, request, document)).rejects.toMatchObject({ status: 502 });
  expect(calls).toHaveLength(2);
  expect(Object.values(calls[0].questions).every(question => question.type === 'choice')).toBe(true);
});

it('bounds selective bootstrap retries to three group selections and three selected assessments', async () => {
  transform = (id, answer) => id === 'coherent' ? { type: 'noul', noul: .1 } : answer;
  const selective = { ...input, selectiveGroupAssessment: true, documents: [manyGroups], canvases: [{ id: manyGroups.canvasId, name: 'Four local subjects' }] };
  const result = await bootstrapGrouping(selective, { ...request, canvasId: manyGroups.canvasId, blockIds: [manyGroups.block.id] }, manyGroups);
  expect(result).toMatchObject({ result: { status: 'insufficient_group_evidence' }, proposals: [] });
  expect(calls).toHaveLength(6);
  expect(calls.filter(call => 'coherent' in call.questions)).toHaveLength(3);
  expect(calls.filter(call => 'coherent' in call.questions).every(call => Object.keys(call.questions).length === 2)).toBe(true);
});
