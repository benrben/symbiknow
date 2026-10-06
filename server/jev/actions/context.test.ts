import { describe, expect, it } from 'vitest';
import type { JevEvaluationContext } from './context.js';
import { arrayOption, candidates, confidence, exactEvidence, judge, json, passages, selected,
  selectedDocuments, sourceState, supported, textOption } from './context.js';
import { choice, noul, score, type JevAnswer } from '../../jev.js';
import { lexicalScore, topologicalOrder } from './candidates.js';
import { jevActions, type JevSettings } from '../../../shared/jev-types.js';

function context(answer: JevAnswer | undefined): JevEvaluationContext {
  return { workspaceId: 'workspace', documents: [], canvases: [], tasks: [], vocabulary: [],
    settings: { externalProcessing: true, people: [], paused: false, schedules: [],
      modes: Object.fromEntries(jevActions.map(action => [action, 'suggest'])) as JevSettings['modes'] },
    apiKey: 'fixture', decider: async () => {
      const result: Record<string, JevAnswer> = {};
      if (answer) result.question = answer;
      return result;
    } };
}
function selectedAnswer(choiceId = 'yes'): JevAnswer {
  return { type: 'choice', choice: choiceId, confidence: 0.9, probabilities: { yes: 1, no: 0 } };
}
describe('Symbi Reflex decision validation and source contracts', () => {
  it('validates injected decision boundaries instead of trusting TypeScript types', async () => {
    const question = choice('Choose a supported outcome', { yes: 'Supported', no: 'Unsupported' });
    const invalid = [undefined, { type: 'noul', noul: 0.9 },
      { ...selectedAnswer(), confidence: NaN },
      { ...selectedAnswer(), probabilities: { yes: NaN, no: 0 } },
      { ...selectedAnswer(), probabilities: { yes: 0.9 } },
      { ...selectedAnswer(), probabilities: { yes: 0.2, no: 0.1 } },
      { ...selectedAnswer(), choice: 'unknown' },
      { ...selectedAnswer(), probabilities: { yes: 0.1, no: 0.9 } },
    ] as Array<JevAnswer | undefined>;
    for (const answer of invalid) await expect(judge(context(answer), {}, { question })).rejects.toMatchObject({ status: 502 });
    const badNoul = { type: 'noul', noul: Infinity } as JevAnswer;
    await expect(judge(context(badNoul), {}, { question: noul('Is it supported?') })).rejects.toMatchObject({ status: 502 });
    await expect(judge(context({ type: 'score', score: 1, confidence: NaN, probabilities: { 0: 0, 1: 1 } }), {},
      { question: score('Rate support', ['None', 'Supported']) })).rejects.toMatchObject({ status: 502 });
    for (const value of [-1, 3, NaN]) await expect(judge(context({ type: 'score', score: value,
      confidence: 0.9, probabilities: { 0: 1, 1: 0 } }), {}, { question: score('Rate support', ['None', 'Supported']) }))
      .rejects.toMatchObject({ status: 502 });
    expect(await judge(context(selectedAnswer()), {}, { question })).toMatchObject({ question: { choice: 'yes' } });
  });

  it('refuses missing consent, exhausted budgets, absent keys, and cancellation before inference', async () => {
    const input = context(selectedAnswer());
    input.settings.externalProcessing = false;
    await expect(judge(input, {}, { question: choice('Select', { yes: 'Yes', no: 'No' }) })).rejects.toMatchObject({ status: 403 });
    expect(await judge(input, {}, {})).toEqual({});
    input.settings.externalProcessing = true;
    input.apiKey = '';
    await expect(judge(input, {}, { question: noul('Supported?') })).rejects.toMatchObject({ status: 503 });
    input.apiKey = 'fixture';
    await expect(judge(input, { content: 'a'.repeat(60000) }, { question: noul('Supported?') })).rejects.toMatchObject({ status: 413 });
    input.signal = AbortSignal.abort();
    await expect(judge(input, {}, { question: noul('Supported?') })).rejects.toMatchObject({ status: 499 });
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      delete input.apiKey; delete input.signal;
      await expect(judge(input, {}, { question: noul('Supported?') })).rejects.toMatchObject({ status: 503 });
    } finally {
      if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
    }
  });

  it('keeps optional arguments, no/unknown outcomes, and exact source locations explicit', () => {
    const request = { action: 'profile' as const, canvasId: 'canvas', options: { string: 'value', list: ['one', 4], bad: false } };
    expect(textOption(request, 'string')).toBe('value');
    expect(textOption(request, 'bad')).toBe('');
    expect(arrayOption(request, 'list')).toEqual(['one']);
    expect(arrayOption(request, 'bad')).toEqual([]);
    expect(supported({ type: 'noul', noul: 0.1 })).toBe(false);
    expect(supported(undefined)).toBe(false);
    expect(selected(undefined)).toBeUndefined();
    expect(selected({ ...selectedAnswer(), type: 'choice', choice: 'none' } as JevAnswer)).toBeUndefined();
    expect(selected({ ...selectedAnswer(), probabilities: { yes: 0.3, no: 0.7 } } as JevAnswer)).toBeUndefined();
    expect(confidence({ type: 'noul', noul: 0.2 })).toBe(0.2);
    expect(confidence(selectedAnswer())).toBe(0.9);
    expect(candidates([])).toMatchObject({ none: expect.any(String), unknown: expect.any(String) });
    expect(json({ value: undefined, preserved: null })).toEqual({ preserved: null });
  });

  it('applies scoped semantic cutoffs to both choice certainty and probability while preserving bare helper defaults', () => {
    const input = context(undefined);
    const answer = { type: 'choice', choice: 'yes', confidence: 0.75, probabilities: { yes: 0.75, no: 0.25 } } as const;
    input.confidenceThreshold = 0.65;
    expect(selected(answer, input)).toBe('yes');
    expect(supported({ type: 'noul', noul: 0.75 }, input)).toBe(true);
    input.confidenceThreshold = 0.85;
    expect(selected(answer, input)).toBeUndefined();
    expect(selected({ ...answer, confidence: 0.95 }, input)).toBeUndefined();
    expect(selected({ ...answer, probabilities: { yes: 0.95, no: 0.05 } }, input)).toBeUndefined();
    expect(supported({ type: 'noul', noul: 0.75 }, input)).toBe(false);
    delete input.confidenceThreshold;
    expect(selected(answer, input)).toBe('yes');
    expect(selected({ ...answer, confidence: 0.6, probabilities: { yes: 0.6, no: 0.4 } }, input)).toBeUndefined();
    expect(selected({ ...answer, confidence: 0.1, probabilities: { yes: 0.6, no: 0.4 } })).toBe('yes');
    expect(supported({ type: 'noul', noul: 0.69 })).toBe(false);
  });

  it('orders declared prerequisites and reports actual missing nodes and bounded cycles', () => {
    expect(lexicalScore('', 'anything')).toBe(0);
    expect(lexicalScore('שלום צוות', 'שלום צוות עובד')).toBe(1);
    expect(topologicalOrder(['a', 'b'], new Map([['a', ['b']], ['b', []]]))).toEqual({ order: ['b', 'a'], cycles: [], missing: [] });
    expect(topologicalOrder(['a', 'b'], new Map([['a', ['b']], ['b', ['a']]]))).toEqual({ order: [], cycles: ['a', 'b'], missing: [] });
    expect(topologicalOrder(['a'], new Map([['a', ['missing']]]))).toEqual({ order: ['a'], cycles: [], missing: ['missing'] });
    expect(topologicalOrder(['a'], new Map())).toEqual({ order: ['a'], cycles: [], missing: [] });
  });

  it('does not invent passages for empty sources and resolves exact selected offsets', () => {
    const input = context(undefined);
    const source = { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'document',
      incarnation: 'inc', sourceGeneration: 1, contentHash: 'hash', metadataRevision: 1 },
    block: { id: 'document', title: 'Title', file: 'doc.md', kind: 'markdown' as const, content: '  First line.\n\nSecond line.',
      x: 0, y: 0, width: 1, height: 1, links: [] } };
    input.documents.push(source);
    expect(passages(source).map(passage => [passage.quote, passage.start])).toEqual([['First line.', 2], ['Second line.', 15]]);
    expect(exactEvidence(source, { ...selectedAnswer(), choice: 'p1', probabilities: { p1: 1 } } as JevAnswer)[0].quote).toBe('Second line.');
    expect(selectedDocuments(input, { action: 'profile', canvasId: 'canvas' })).toHaveLength(1);
    source.block.content = '   \n\t\n';
    expect(passages(source)).toEqual([]);
    source.block.content = '';
    expect(passages(source)).toEqual([]);
    expect(sourceState(source).coverage).toBe(0);
    expect(exactEvidence(source, undefined)).toEqual([]);
  });
});
