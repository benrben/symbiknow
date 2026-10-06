import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jevActions, type JevActionRequest, type JevVocabularyTerm } from '../../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../../jev.js';
import { CanvasStore } from '../../storage.js';
import type { StoredCanvas } from '../../storage-shapes.js';
import { evaluationContext } from '../context.js';
import { emptyJevWorkspace } from '../workspace.js';
import { automaticPeople, automaticRecall, automaticVocabulary } from './automatic.js';
import { assignOwner } from './work.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';

type Rule = (id: string, question: JevQuestion, state: Record<string, unknown>) => string | number | undefined;
function document(id: string, content = '# Atlas\nAlice owns the Atlas release.', canvasId = 'canvas'): JevInputDocument {
  return { canvasId, block: { id, title: 'Atlas', content, file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 1, height: 1, links: [] },
    snapshot: { workspaceId: 'workspace', canvasId, blockId: id, incarnation: `inc-${id}`, sourceGeneration: 1, metadataRevision: 1, contentHash: `hash-${id}` } };
}
function answer(id: string, question: JevQuestion, state: Record<string, unknown>, rule: Rule): JevAnswer {
  const batch = /^(\d+)__(.*)$/.exec(id);
  const questionState = batch ? (state.questionSets as Record<string, unknown>[])[Number(batch[1])] : state;
  const questionId = batch?.[2] ?? id;
  const value = rule(questionId, question, questionState);
  if (question.type === 'noul') return { type: 'noul', noul: Number(value ?? (questionId === 'conflict' ? 0.01 : 0.98)) };
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const picked = String(value ?? keys[0]);
  const probabilities = Object.fromEntries(keys.map(key => [key, key === picked ? 1 : 0]));
  return question.type === 'choice' ? { type: 'choice', choice: picked, probabilities, confidence: 1 }
    : { type: 'score', score: Number(picked), probabilities, confidence: 1 };
}
function context(rule: Rule = () => undefined): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [document('one')], canvases: [{ id: 'canvas', name: 'Atlas' }], vocabulary: [], tasks: [],
    settings: { paused: false, externalProcessing: true, people: [], schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevEvaluationContext['settings']['modes'] },
    apiKey: 'fixture', decider: async (_key, state, questions) => Object.fromEntries(Object.entries(questions)
      .map(([id, question]) => [id, answer(id, question, state as Record<string, unknown>, rule)])) };
}
function request(action: JevActionRequest['action'], options: JevActionRequest['options'] = {}): JevActionRequest {
  return { action, canvasId: 'canvas', blockIds: ['one'], options };
}
function term(name: string, kind: JevVocabularyTerm['kind'] = 'label'): JevVocabularyTerm {
  return { id: name, name, kind, definition: 'Atlas release requirements.', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: 'canvas', blockId: 'one' }] };
}

describe('automatic source-grounded vocabulary and supporting knowledge', () => {
  it('bootstraps useful HTML labels and one shared source category from body prose beyond long styles', async () => {
    const assessments: Array<{ instructions: string; concept: Record<string, unknown>; sourceCount: number }> = [];
    const input = context((id, question, state) => {
      if (id === 'fit' && state.selectedConcept) {
        const concept = state.selectedConcept as Record<string, unknown>;
        const sources = state.sources as Array<{ passages: Array<{ text: string }> }>;
        assessments.push({ instructions: question.instructions, concept, sourceCount: sources.length });
        return sources.every(source => source.passages.some(passage => /Node\.js|checked API responses/.test(passage.text))) ? 0.98 : 0.1;
      }
      if (id !== 'concept' || !('kind' in state) || question.type !== 'choice') return undefined;
      if (state.kind === 'entity') return 'none';
      const name = state.kind === 'group' ? 'Platform —' : (state.source as { title: string }).title;
      return Object.keys(question.criteria).find(key => question.criteria[key].startsWith(name)) ?? 'none';
    });
    const html = (title: string, purpose: string) => `---\nformat: html\n---\n<!doctype html><html><head><style>${'body{color:red;}\n'.repeat(250)}</style>
      <script>const hiddenTopic = 'Invented finance group';</script></head><body>
      <div><span></span>Platform · ${title}</div><h1>${title}</h1><p>${purpose}</p><div>Documentation · ${title}</div><h2>Design principles</h2>
      <p>Clients share checked source updates and preserve file history.</p></body></html>`;
    const architecture = document('one', html('Architecture', 'One Node.js server serves the React app, REST API, and MCP clients.'));
    architecture.block.title = 'Architecture';
    const api = document('api', html('REST API', 'Every client uses JSON requests and checked API responses.'));
    api.block.title = 'REST API';
    const elsewhere = document('elsewhere', html('External platform', 'Unrelated external system.'), 'other');
    const excluded = document('excluded', html('Private platform', 'Excluded private system.')); excluded.block.processingExcluded = true;
    input.documents = [architecture, api, elsewhere, excluded];
    const result = await automaticVocabulary(input, request('vocab_lifecycle'));
    expect(result.proposals).toHaveLength(2);
    expect(assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceCount: 1, concept: expect.objectContaining({ kind: 'label', name: 'Architecture',
        nameOrigin: 'document_title', definitionBasis: 'visible_source_excerpts' }) }),
      expect.objectContaining({ sourceCount: 2, concept: expect.objectContaining({ kind: 'group', name: 'Platform',
        nameOrigin: 'explicit_shared_source_category', definitionBasis: 'visible_source_excerpts' }) }),
    ]));
    expect(assessments.every(assessment => /label names a main topic/.test(assessment.instructions)
      && /source category.*body fits/.test(assessment.instructions) && /quoted scope examples/.test(assessment.instructions)
      && /Reject incidental names/.test(assessment.instructions))).toBe(true);
    const group = result.proposals.find(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.term.kind === 'group')!;
    expect(group.mutation).toMatchObject({ term: { name: 'Platform', groupKey: 'custom:platform',
      members: [{ canvasId: 'canvas', blockId: 'one' }, { canvasId: 'canvas', blockId: 'api' }] } });
    expect(group.sources.map(source => source.blockId)).toEqual(['one', 'api']);
    expect(group.mutation.kind === 'vocabulary' && group.mutation.term.definition).toContain('One Node.js server');
    expect(group.mutation.kind === 'vocabulary' && group.mutation.term.definition).toContain('checked API responses');
    expect(result.proposals.every(candidate => !JSON.stringify(candidate.mutation).includes('hiddenTopic'))).toBe(true);
    expect(result.result.discoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'label', selectedName: 'Architecture', status: 'proposed' }),
      expect.objectContaining({ kind: 'group', selectedName: 'Platform', status: 'proposed' }),
      expect.objectContaining({ kind: 'entity', choice: 'none', status: 'insufficient_concept_evidence' }),
    ]));
    input.vocabulary = result.proposals.flatMap(candidate => candidate.mutation.kind === 'vocabulary' ? [candidate.mutation.term] : []);
    const repeated = await automaticVocabulary(input, request('vocab_lifecycle'));
    expect(repeated.proposals).toEqual([]);
    const second = await automaticVocabulary(input, { ...request('vocab_lifecycle'), blockIds: ['api'] });
    expect(second.proposals.map(candidate => candidate.mutation)).toEqual([
      expect.objectContaining({ kind: 'vocabulary', term: expect.objectContaining({ kind: 'label', name: 'REST API' }) }),
    ]);
    expect(group.evidence.every(passage => input.documents.some(source => source.snapshot === passage.source
      && source.block.content.slice(passage.start, passage.end) === passage.quote))).toBe(true);
  });

  it('reports source and support abstention honestly and prevents labels longer than the native tag contract', async () => {
    const input = context(() => undefined);
    input.documents[0].block.title = 'An explanatory architecture label that exceeds forty characters';
    input.documents[0].block.content = '';
    const result = await automaticVocabulary(input, request('vocab_lifecycle', { kind: 'label' }));
    expect(result.proposals).toEqual([]);
    expect(result.result.discoveries).toMatchObject([{ kind: 'label', candidateCount: 0, status: 'no_source_concepts' }]);
    input.documents[0].block.title = 'Atlas'; input.documents[0].block.content = '# Atlas\nRelease requirements.';
    input.vocabulary = [{ ...term('Atlas'), state: 'candidate' }];
    input.decider = context(id => id === 'fit' ? 0.3 : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { kind: 'label' }))).result.discoveries)
      .toMatchObject([{ selectedName: 'Atlas', status: 'insufficient_existing_concept_evidence', checkedConfidence: 0.3 }]);
  });

  it('uses a substantive visible heading when a generic card title is not the supported topic', async () => {
    let origin = '';
    const input = context((id, question, state) => {
      if (id === 'concept' && state.kind === 'label' && question.type === 'choice') {
        return Object.keys(question.criteria).find(key => question.criteria[key] === 'Rollback policy');
      }
      if (id === 'fit' && state.selectedConcept) origin = (state.selectedConcept as { nameOrigin: string }).nameOrigin;
      return undefined;
    });
    input.documents[0].block.title = 'Notes';
    input.documents[0].block.content = '# Rollback policy\nDeployments retain an earlier version until review passes.';
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { kind: 'label' }))).proposals[0].mutation)
      .toMatchObject({ term: { name: 'Rollback policy' } });
    expect(origin).toBe('visible_source_heading');
  });

  it('discovers exact heading, explicit person, and group concepts without manual selectors', async () => {
    const input = context();
    const result = await automaticVocabulary(input, request('vocab_lifecycle'));
    expect(result.result).toMatchObject({ automaticDiscovery: true, status: 'proposed', proposalCount: 3 });
    const concepts = result.proposals.map(candidate => candidate.mutation);
    expect(concepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'vocabulary', operation: 'define', term: expect.objectContaining({ name: 'Atlas', kind: 'label', state: 'active' }) }),
      expect.objectContaining({ kind: 'vocabulary', operation: 'define', term: expect.objectContaining({ name: 'Alice', kind: 'entity', state: 'active' }) }),
      expect.objectContaining({ kind: 'vocabulary', operation: 'define', term: expect.objectContaining({ name: 'Atlas', kind: 'group', groupKey: 'custom:atlas' }) }),
    ]));
    expect(result.proposals.every(candidate => candidate.evidence.length > 0 && candidate.decisionConfidences?.every(Number.isFinite))).toBe(true);
    expect(input.vocabulary).toEqual([]);
  });

  it('defines labels for each source, uses title when there is no heading, and makes no repeated unchanged definitions', async () => {
    const input = context();
    input.documents = [document('one', 'Atlas release requirements.'), document('two', 'Delivery evidence.')];
    input.documents[1].block.title = 'Delivery';
    const scope = { action: 'vocab_lifecycle' as const, canvasId: 'canvas', options: { kind: 'label' } };
    const result = await automaticVocabulary(input, scope);
    expect(result.proposals).toHaveLength(2);
    input.vocabulary = result.proposals.flatMap(candidate => candidate.mutation.kind === 'vocabulary' ? [candidate.mutation.term] : []);
    expect((await automaticVocabulary(input, scope)).proposals).toEqual([]);
  });

  it('rejects unsupported names and unsupported concept definitions', async () => {
    const input = context((id, _question, state) => id === 'concept' && 'kind' in state ? 'none' : undefined);
    expect((await automaticVocabulary(input, request('vocab_lifecycle'))).proposals).toEqual([]);
    input.decider = context(id => id === 'fit' ? 0.2 : undefined).decider;
    expect((await automaticVocabulary(input, request('vocab_lifecycle'))).proposals).toEqual([]);
    input.documents[0].block.title = '';
    input.documents[0].block.content = '';
    expect((await automaticVocabulary(input, request('vocab_lifecycle'))).result.status).toBe('no_change');
  });

  it('promotes source-supported candidates and respects retired concepts and removed label corrections', async () => {
    const input = context();
    input.vocabulary = [{ ...term('Atlas'), state: 'candidate' }];
    const action = request('vocab_lifecycle', { kind: 'label' });
    const result = await automaticVocabulary(input, action);
    expect(result.proposals[0].mutation).toMatchObject({ operation: 'promote', term: { state: 'active', version: 2 } });
    expect(result.proposals[0].decisionConfidences).toEqual([1, 0.98]);
    input.decider = context(id => id === 'fit' ? 0.1 : undefined).decider;
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.vocabulary[0].state = 'retired';
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.vocabulary = [];
    input.documents[0].block.jevOwnership = { managed: ['tags'], pins: [], removedLabels: ['Atlas'], removedLinks: [] };
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
  });

  it('uses existing native group names and ignores invalid or unresolved nested paths', async () => {
    const input = context();
    input.documents[0].block.group = 'custom:atlas';
    const group = request('vocab_lifecycle', { kind: 'group' });
    expect((await automaticVocabulary(input, group)).proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:atlas' } });
    input.documents[0].block.group = undefined;
    input.canvases[0].groups = [{ id: 'custom:releases', name: 'Releases' }];
    input.decider = context((id, question, state) => id === 'concept' && 'kind' in state
      ? Object.keys(question.type === 'choice' ? question.criteria : {}).find(key => question.type === 'choice' && question.criteria[key] === 'Releases') ?? 'none' : undefined).decider;
    expect((await automaticVocabulary(input, group)).proposals[0].mutation).toMatchObject({ term: { name: 'Releases', groupKey: 'custom:releases' } });
    input.canvases[0].groups = [{ id: 'broken:path', name: 'Releases' }, { id: 'custom:missing/release', name: 'Releases' }];
    expect((await automaticVocabulary(input, group)).proposals).toEqual([]);
    input.vocabulary = [{ ...term('Parent', 'group'), groupKey: 'custom:parent' }];
    input.canvases[0].groups = [{ id: 'custom:parent/releases', name: 'Releases' }];
    expect((await automaticVocabulary(input, group)).proposals[0].mutation).toMatchObject({ term: { groupKey: 'custom:parent/releases', parentId: 'Parent' } });
  });

  it('checks and repairs a missing active-group contributor using current canonical source guards', async () => {
    const input = context();
    const original = input.documents[0];
    original.block.group = 'custom:atlas';
    const added = document('added', '# Atlas\nThe Atlas API serves checked release evidence.');
    added.block.group = 'custom:atlas';
    added.snapshot = { ...added.snapshot, sourceGeneration: 3, metadataRevision: 7, contentHash: 'latest-source-hash' };
    input.documents.push(added);
    const existing = { ...term('Atlas', 'group'), groupKey: 'custom:atlas', version: 4 };
    input.vocabulary = [existing];
    const action = { ...request('vocab_lifecycle', { kind: 'group' }), blockIds: ['added'] };
    const checked = await automaticVocabulary(input, action);
    expect(checked.proposals).toHaveLength(1);
    expect(checked.proposals[0].mutation).toMatchObject({ kind: 'vocabulary', operation: 'promote', term: {
      id: existing.id, state: 'active', version: 5, definition: existing.definition, groupKey: existing.groupKey,
      members: [{ canvasId: 'canvas', blockId: 'one' }, { canvasId: 'canvas', blockId: 'added' }],
    } });
    expect(checked.proposals[0].decisionConfidences).toEqual([1, 0.98]);
    expect(checked.proposals[0].sources).toEqual([original.snapshot, added.snapshot]);
    expect(checked.proposals[0].evidence.every(passage => input.documents.some(source => source.snapshot === passage.source
      && source.block.content.slice(passage.start, passage.end) === passage.quote))).toBe(true);
    expect(input.vocabulary).toEqual([existing]);
    expect(existing.members).toEqual([{ canvasId: 'canvas', blockId: 'one' }]);

    input.decider = context(id => id === 'fit' ? 0.69 : undefined).decider;
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.decider = context().decider;
    input.vocabulary = [{ ...existing, members: [...existing.members, { canvasId: 'canvas', blockId: 'added' }] }];
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
  });

  it('does not revive retired groups or repair a source outside the canonical group, while candidates remain checked', async () => {
    const input = context();
    const existing = { ...term('Atlas', 'group'), groupKey: 'custom:atlas', members: [] };
    input.vocabulary = [existing];
    const action = request('vocab_lifecycle', { kind: 'group' });
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.documents[0].block.group = existing.groupKey;
    input.vocabulary = [{ ...existing, state: 'retired' }];
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.vocabulary = [{ ...existing, state: 'candidate' }];
    expect((await automaticVocabulary(input, action)).proposals[0].mutation)
      .toMatchObject({ operation: 'promote', term: { state: 'active', version: 2, members: [{ canvasId: 'canvas', blockId: 'one' }] } });
  });

  it('keeps explicit vocabulary operations and explicit names on their checked implementation', async () => {
    const input = context();
    const defined = await automaticVocabulary(input, request('vocab_lifecycle', { kind: 'label', name: 'Atlas' }));
    expect(defined.proposals[0].mutation).toMatchObject({ operation: 'define', term: { name: 'Atlas' } });
    input.vocabulary = [term('Atlas')];
    expect((await automaticVocabulary(input, request('vocab_lifecycle', { operation: 'rename', termId: 'Atlas', name: 'Release' }))).proposals[0].mutation)
      .toMatchObject({ operation: 'rename', term: { name: 'Release' } });
  });

  it('merges only independently supported equivalent definitions and leaves unrelated concepts intact', async () => {
    const input = context();
    input.documents[0].block.tags = ['Release'];
    input.vocabulary = [term('Atlas'), term('Release')];
    const action = request('vocab_lifecycle', { kind: 'label' });
    const merged = await automaticVocabulary(input, action);
    expect(merged.result.synonymySupported).toBe(true);
    expect(merged.proposals.some(candidate => candidate.mutation.kind === 'vocabulary' && candidate.mutation.operation === 'merge')).toBe(true);
    expect(merged.proposals.every(candidate => candidate.decisionConfidences?.every(Number.isFinite))).toBe(true);
    input.decider = context(id => id === 'synonymous' ? 0.1 : undefined).decider;
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.decider = context(id => id === 'pair' ? 'none' : undefined).decider;
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
    input.vocabulary[1].definition = 'Legal invoice collection.';
    expect((await automaticVocabulary(input, action)).proposals).toEqual([]);
  });

  it('finds supporting passages and conflicts automatically, excludes self, and preserves every exact evidence snapshot', async () => {
    const input = context(id => id === 'conflict' ? 0.98 : undefined);
    const source = input.documents[0];
    input.documents.push(document('support', 'Atlas release has shipped.', 'other'), document('excluded', 'Atlas release secrets.', 'other'));
    input.documents[2].block.processingExcluded = true;
    const result = await automaticRecall(input, request('recall'));
    expect(result.result.documents).toMatchObject({ one: { automatic: true, evidenceFound: true, candidateCount: 1 } });
    const candidate = result.proposals[0];
    expect(candidate.mutation).toMatchObject({ kind: 'derived', blockId: 'one', values: { recall: { conflicts: [{ kind: 'premise_conflict' }] } } });
    expect(candidate.sources).toEqual([source.snapshot, input.documents[1].snapshot]);
    expect(candidate.evidence.every(passage => input.documents.some(item => item.snapshot === passage.source
      && item.block.content.slice(passage.start, passage.end) === passage.quote))).toBe(true);
    expect(candidate.mutation.kind === 'derived' && JSON.stringify(candidate.mutation.values).includes('"blockId":"one"')).toBe(false);
  });

  it('asks an actual supporting-evidence question using readable HTML claims including the opening body paragraph', async () => {
    const input = context();
    input.documents[0].block.title = 'Architecture';
    input.documents[0].block.content = '---\nformat: html\n---\n<html><head><style>body{color:red}</style></head><body><div>Platform · Architecture</div><h1>The server contract</h1><p>The <code>CanvasStore</code> persists documents and rejects stale writes.</p><h2>Implementation details</h2><p>Additional implementation detail.</p><p>Closing contact instructions.</p></body></html>';
    input.documents.push(document('support', 'CanvasStore rejects stale writes using the expected source hash.'));
    const result = await automaticRecall(input, request('recall'));
    const query = ((result.result.documents as Record<string, { query: string }>).one.query);
    expect(query).toContain('Which other source passages support, explain, qualify, or contradict');
    expect(query).toContain('CanvasStore persists documents and rejects stale writes.');
    expect(query).not.toContain('Closing contact instructions.');
    expect(query).not.toContain('<code>'); expect(query).not.toContain('color:red');
    expect(query.length).toBeLessThanOrEqual(1800);
    expect(result.proposals[0].sources.map(source => source.blockId)).toEqual(['one', 'support']);
  });

  it('keeps automatic recall queries and exact supporting evidence stable after adding a generated tag equal to the title', async () => {
    const seen: string[] = [];
    const input = context((_id, _question, state) => {
      if (typeof state.query === 'string') seen.push(state.query);
      return undefined;
    });
    input.documents.push(document('support', 'Atlas release requirements are checked against source evidence.'));
    const content = input.documents[0].block.content;
    const original = await automaticRecall(input, request('recall'));
    const query = (original.result.documents as Record<string, { query: string }>).one.query;
    expect(query).toContain('Topic: Atlas\n'); expect(seen).toContain(query);
    input.documents[0].block.tags = ['Atlas']; seen.length = 0;
    const equal = await automaticRecall(input, request('recall'));
    expect((equal.result.documents as Record<string, { query: string }>).one.query).toBe(query);
    expect(equal.proposals[0].evidence).toEqual(original.proposals[0].evidence);
    expect(equal.proposals[0].sources).toEqual(original.proposals[0].sources);
    expect(seen).toContain(query); expect(new Set(seen)).toEqual(new Set([query]));
    input.documents[0].block.tags = ['Atlas', 'Release operations']; seen.length = 0;
    const distinct = await automaticRecall(input, request('recall'));
    const changed = (distinct.result.documents as Record<string, { query: string }>).one.query;
    expect(changed).not.toBe(query); expect(changed).toContain('Topic: Atlas, Release operations\n'); expect(seen).toContain(changed);
    expect(input.documents[0].block.content).toBe(content);
  });

  it('keeps explicit recall queries, local fallback, archived scope, and empty automatic scope honest', async () => {
    const input = context();
    expect((await automaticRecall(input, { ...request('recall'), query: 'Atlas' })).proposals).toEqual([]);
    input.settings.externalProcessing = false;
    input.documents.push(document('support', 'Atlas release evidence.'), document('archive', 'Atlas historical evidence.'));
    input.documents[2].block.archived = true;
    let result = await automaticRecall(input, request('recall'));
    expect(result.result.documents).toMatchObject({ one: { evidenceStatus: 'local_unverified', candidateCount: 1 } });
    result = await automaticRecall(input, request('recall', { includeArchived: true }));
    expect(result.result.documents).toMatchObject({ one: { candidateCount: 2 } });
    input.documents[0].block.processingExcluded = true;
    expect((await automaticRecall(input, request('recall'))).result.status).toBe('no_available_sources');
    input.documents = [];
    expect((await automaticRecall(input, { action: 'recall', canvasId: 'canvas' })).result.status).toBe('no_available_sources');
  });

  it('does not guess people from authorship or incidental names and retains configured identifiers', () => {
    const source = document('one', 'Owner: Alice\nReviewer: Bob Smith\nDana owns the launch.\nEli will review the launch.\nAuthor: Carol\nFred discusses the launch.');
    const known = [{ id: 'alice-configured', name: 'Alice', role: 'Product owner' }];
    const people = automaticPeople([source], known);
    expect(people.map(person => person.name)).toEqual(['Alice', 'Bob Smith', 'Dana', 'Eli']);
    expect(people[0]).toEqual(known[0]);
    expect(automaticPeople([source], known)).toEqual(people);
    expect(people[1].id).toMatch(/^source-person-[a-f0-9]{18}$/);
    source.block.processingExcluded = true;
    expect(automaticPeople([source], known)).toEqual(known);
    expect(automaticPeople([document('blank', '')], [])).toEqual([]);
  });

  it('keeps every configured person and bounds additional exact responsibility names', () => {
    const known = Array.from({ length: 50 }, (_, index) => ({ id: `known-${index}`, name: `Known ${index}`, role: 'Configured owner' }));
    const content = Array.from({ length: 30 }, (_, index) => `Owner: Person${String.fromCharCode(65 + index)}.`).join('\n');
    const people = automaticPeople([document('one', content)], known);
    expect(people.slice(0, 50)).toEqual(known);
    expect(people).toHaveLength(74);
    expect(people[50].name).toBe('PersonA');
  });

  it('preserves distinct configured identities with the same name and deduplicates only inferred names', () => {
    const known = [{ id: 'alice-owner', name: 'Alice', role: 'Release owner' },
      { id: 'alice-reviewer', name: 'Alice', role: 'Security reviewer' }];
    const source = document('one', 'Owner: Alice\nReviewer: Bob\nBob owns the launch.\nReviewer: BOB');
    const people = automaticPeople([source, source], known);
    expect(people.slice(0, known.length)).toEqual(known);
    expect(people.map(person => person.name)).toEqual(['Alice', 'Alice', 'Bob']);
    expect(new Set(people.map(person => person.id)).size).toBe(people.length);
  });

  it('does not overwrite or duplicate a configured identifier when a source identity collides', () => {
    const source = document('one', 'Owner: Alice\nReviewer: Bob');
    const inferredId = automaticPeople([document('alice', 'Owner: Alice')], [])[0].id;
    const known = [{ id: inferredId, name: 'Charlie', role: 'Configured owner' }];
    const people = automaticPeople([source], known);
    expect(people[0]).toEqual(known[0]);
    expect(people.map(person => person.name)).toEqual(['Charlie', 'Bob']);
    expect(new Set(people.map(person => person.id)).size).toBe(people.length);
  });

  it('finds explicit responsibility in a selected source after 32 other native sources while preserving configured people', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jev-selected-responsibility-'));
    try {
      const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
      const workspace = await store.createWorkspace({ name: 'Selected responsibility' });
      const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
      const reference = await store.createBlock(canvas.id, { title: 'Reference 0', content: 'General release reference.' });
      const source = await store.createBlock(canvas.id, { title: 'Atlas release', content: 'Owner: Alice\nAlice owns the Atlas release.' });
      const canvasFile = path.join(root, 'canvases', `${canvas.id}.json`);
      const saved = JSON.parse(await readFile(canvasFile, 'utf8')) as StoredCanvas;
      // Restore a valid source collection directly to disk without 31 fixture-only Git commits.
      const references = Array.from({ length: 32 }, (_, index) => index === 0 ? saved.blocks[0] : {
        ...saved.blocks[0], id: `reference-${index}`, file: `docs/reference-${index}.md`, incarnation: `reference-${index}`,
      });
      await Promise.all(references.slice(1).map(block => writeFile(path.join(root, block.file), reference.content)));
      await writeFile(canvasFile, JSON.stringify({ ...saved, blocks: [...references, saved.blocks[1]] }));
      const task = await store.createTask(canvas.id, { title: 'Atlas release', detail: 'Deliver Atlas.' }, 'Browser');
      const state = emptyJevWorkspace();
      const known = { id: 'configured-reviewer', name: 'Bob', role: 'Configured reviewer' };
      state.settings.people = [known];
      const request: JevActionRequest = { action: 'assign_owner', canvasId: canvas.id, blockIds: [source.id], options: { taskId: task.id } };
      const input = await evaluationContext(store, workspace.id, state, request,
        { id: 'owner', kind: 'user', access: 'write', canApprove: true }, new AbortController().signal);
      expect(input.documents[32].block.id).toBe(source.id);
      expect(input.settings.people).toContainEqual(known);
      const alice = input.settings.people.find(person => person.name === 'Alice')!;
      expect(alice.id).toMatch(/^source-person-/);
      input.apiKey = 'native-responsibility-decider';
      input.decider = context((id, question) => id === 'person' && question.type === 'choice'
        ? Object.keys(question.criteria).find(key => question.criteria[key].startsWith('Alice:')) : undefined).decider;
      const result = await assignOwner(input, request);
      expect(result.proposals[0].mutation).toMatchObject({ kind: 'task_update', taskId: task.id, patch: { assignee: alice.id } });
      expect(result.proposals[0].evidence[0].source.blockId).toBe(source.id);
      expect(state.settings.people).toEqual([known]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
