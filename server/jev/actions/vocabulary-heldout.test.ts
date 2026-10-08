import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { vocabularyHeldout, vocabularyHeldoutAnswerKey } from '../../../scripts/jev-bench/data/vocabulary-heldout.mjs';
import { vocabularyCorpus, vocabularyHeldoutContext } from '../../../scripts/jev-bench/vocabulary-heldout-context.mjs';
import { evaluateVocabularyPair } from '../../../scripts/jev-bench/vocabulary-pair-evaluation.mjs';
import type { JevDecider } from '../../jev.js';

it('freezes twelve independent fictional pairs and their balanced merge/nonmerge answer keys', () => {
  expect(vocabularyHeldout).toHaveLength(12);
  expect(new Set(vocabularyHeldout.map(item => item.domain)).size).toBe(12);
  expect(vocabularyHeldout.filter(item => item.expectedMerge)).toHaveLength(6);
  expect(vocabularyHeldout.filter(item => !item.expectedMerge)).toHaveLength(6);
  expect(Object.keys(vocabularyHeldoutAnswerKey)).toEqual(vocabularyHeldout.map(item => item.id));
  expect(vocabularyHeldoutAnswerKey).toEqual({ 'star-brightness': true, 'hive-work': false, 'kiln-cycles': true,
    'oral-records': false, 'sailing-turns': true, 'timber-work': false, 'bread-rest': true, 'garden-layout': false,
    'choir-preparation': true, 'geological-records': false, 'cycle-brakes': true, 'loom-work': false });
  expect(Object.isFrozen(vocabularyHeldoutAnswerKey)).toBe(true);
  expect(vocabularyHeldout.every(item => Object.isFrozen(item) && Object.isFrozen(item.source) && Object.isFrozen(item.target))).toBe(true);
});

it('supplies twenty-four distinct documents on other canvases with exact independently authored member evidence', () => {
  const members = vocabularyHeldout.flatMap(item => [item.source, item.target]);
  expect(new Set(members.map(member => member.documentId)).size).toBe(24);
  expect(new Set(members.map(member => member.canvasId)).size).toBe(24);
  expect(JSON.stringify(vocabularyHeldout)).not.toMatch(/Atlas|SymbiKnow|access tokens|Vitest/i);
  for (const item of vocabularyHeldout) {
    const input = vocabularyHeldoutContext(item, async () => { throw new Error('Fixture inspection must not call a provider'); });
    expect(input.canvases.find(canvas => canvas.id === 'merge-only')).toBeDefined();
    expect(input.documents.filter(document => document.canvasId === 'merge-only')).toEqual([]);
    for (const [index, member] of [item.source, item.target].entries()) {
      const document = input.documents[index];
      const start = document.block.content.indexOf(member.evidence);
      expect(start).toBeGreaterThan(0);
      expect(document.block.content.slice(start, start + member.evidence.length)).toBe(member.evidence);
      expect(member.evidence.length).toBeGreaterThan(150);
      expect(document.snapshot).toMatchObject({ workspaceId: input.workspaceId, canvasId: member.canvasId,
        blockId: member.documentId, contentHash: createHash('sha256').update(member.content).digest('hex').slice(0, 16) });
      expect(input.vocabulary[index]).toMatchObject({ name: member.name, definition: member.definition,
        kind: 'label', state: 'active', members: [{ canvasId: member.canvasId, blockId: member.documentId }] });
    }
  }
});

it('uses the same shipped lifecycle and automatic paths with separate member contexts and no fixture mutation', async () => {
  for (const item of vocabularyHeldout) {
    const states: Array<{ sourceName: string; targetName: string; contexts: Array<{ id: string }> }> = [];
    const decider: JevDecider = async (_key, state, questions) => {
      states.push(state as typeof states[number]);
      expect(Object.keys(questions)).toEqual(['synonymous']);
      expect(questions.synonymous.type).toBe('noul');
      expect(questions.synonymous.instructions).toContain('same intended meaning and boundaries');
      return { synonymous: { type: 'noul', noul: item.expectedMerge ? .99 : .01 } };
    };
    const input = vocabularyHeldoutContext(item, decider);
    const before = JSON.stringify({ documents: input.documents, vocabulary: input.vocabulary });
    const row = await evaluateVocabularyPair({ caseId: item.id, pair: `${item.source.name}~${item.target.name}`,
      truth: item.expectedMerge, input }, decider);
    expect(row).toMatchObject({ caseId: item.id, accepted: item.expectedMerge, automaticAccepted: item.expectedMerge,
      automaticAssessed: true, automaticMergeCount: item.expectedMerge ? 1 : 0 });
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ sourceName: item.source.name, targetName: item.target.name,
      contexts: [{ id: item.source.documentId }] });
    expect(states[1]).toMatchObject({ sourceName: item.target.name, targetName: item.source.name,
      contexts: [{ id: item.target.documentId }] });
    expect(JSON.stringify(states)).not.toMatch(/expectedMerge|answerKey|synthetic-vocabulary-heldout/);
    expect(JSON.stringify({ documents: input.documents, vocabulary: input.vocabulary })).toBe(before);
  }
});

it('selects independent heldout explicitly and rejects misspelled or incomplete corpus arguments', () => {
  expect(vocabularyCorpus([])).toBe('normal');
  expect(vocabularyCorpus(['heldout'])).toBe('heldout');
  expect(vocabularyCorpus(['--corpus', 'independent-heldout'])).toBe('independent-heldout');
  for (const args of [['--corpus'], ['indpendent-heldout'], ['--corpus', 'normal', 'unexpected']]) {
    expect(() => vocabularyCorpus(args)).toThrow('Choose vocabulary corpus');
  }
});
