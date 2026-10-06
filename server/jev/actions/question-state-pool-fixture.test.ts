import { expect, it } from 'vitest';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './question-state-pool.test.helpers.js';

const alpha = { id: 'alpha', title: 'Alpha', passages: [{ id: 'p0', text: 'Alpha owns deployment.' }], coverage: 1 };
const beta = { id: 'beta', title: 'Beta', passages: [{ id: 'p0', text: 'Beta has no deployment responsibility.' }], coverage: 0 };

it('resolves only exact references, owns each mutable result and keeps the raw wire values unchanged', () => {
  const pool = [alpha, beta]; const wire = { source: { $jevSourceRef: 0 }, nested: [{ document: { $jevSourceRef: 1 } }],
    repeated: { $jevSourceRef: 0 }, ordinary: [null, true, 4, '{"$jevSourceRef":0}'] };
  const original = structuredClone(wire); const result = resolveSharedQuestionSources(wire, pool);
  expect(result).toEqual({ source: alpha, nested: [{ document: beta }], repeated: alpha, ordinary: wire.ordinary });
  const expanded = result as unknown as { source: typeof alpha; repeated: typeof alpha };
  expanded.source.passages[0].text = 'Caller edit';
  expect(expanded.repeated.passages[0].text).toBe('Alpha owns deployment.');
  expect(alpha.passages[0].text).toBe('Alpha owns deployment.'); expect(wire).toEqual(original);
});

it('retains markerless legacy fixture inputs when no source pool is supplied', () => {
  const input = { source: alpha, ordinary: {}, values: [null, false, 0, 'text'] };
  const result = resolveSharedQuestionSources(input);
  expect(result).toEqual(input); expect(result).not.toBe(input); expect(result.source).not.toBe(input.source);
});

it.each([undefined, null, '0', -1, .5, NaN, Infinity, 2])('refuses invalid source reference indices (%s)', index => {
  expect(() => resolveSharedQuestionSources({ source: { $jevSourceRef: index } }, [alpha, beta]))
    .toThrow('Invalid synthetic provider source reference index');
});

it('refuses missing pool references and ambiguous marker objects instead of guessing source data', () => {
  expect(() => resolveSharedQuestionSources({ $jevSourceRef: 0 })).toThrow('Invalid synthetic provider source reference index');
  expect(() => resolveSharedQuestionSources({ $jevSourceRef: 0, id: 'beta' }, [alpha]))
    .toThrow('Ambiguous synthetic provider source reference');
});

it.each([null, {}, [null], [{ ...alpha, extra: true }], [{ ...alpha, id: 0 }], [{ ...alpha, title: false }],
  [{ ...alpha, coverage: -1 }], [{ ...alpha, coverage: 1.1 }], [{ ...alpha, coverage: NaN }], [{ ...alpha, coverage: '1' }],
  [{ ...alpha, passages: 'text' }], [{ ...alpha, passages: [null] }], [{ ...alpha, passages: [{ id: 0, text: 'Quote.' }] }],
  [{ ...alpha, passages: [{ id: 'p0', text: 1 }] }], [{ ...alpha, passages: [{ id: 'p0', text: 'Quote.', extra: true }] }]])
('rejects malformed pools before their entries can be treated as evidence (%s)', pool => {
  expect(() => resolveSharedQuestionSources({ $jevSourceRef: 0 }, pool)).toThrow('Invalid synthetic provider source pool');
});

it('resolves instruction and criterion references once while leaving symbolic documentation and original marker text literal', () => {
  const pool = ['Use only this original source.', 'Supported category.', 'Original text contains $jevQuestionText:1 literally.'];
  const wire = { candidate: { type: 'choice', instructions: 'Resolve $jevQuestionText:N through questionTexts[N]. $jevQuestionText:0',
    criteria: { c0: '$jevQuestionText:1', c1: '$jevQuestionText:2', unknown: 'Unknown' } },
  quality: { type: 'score', instructions: '$jevQuestionText:0', criteria: ['Unknown', '$jevQuestionText:1'], additional: [null, true, 4] } };
  const original = structuredClone(wire);
  expect(resolveSharedQuestionTexts(wire, pool)).toEqual({ candidate: { type: 'choice',
    instructions: 'Resolve $jevQuestionText:N through questionTexts[N]. Use only this original source.',
    criteria: { c0: 'Supported category.', c1: 'Original text contains $jevQuestionText:1 literally.', unknown: 'Unknown' } },
  quality: { type: 'score', instructions: 'Use only this original source.', criteria: ['Unknown', 'Supported category.'], additional: [null, true, 4] } });
  expect(wire).toEqual(original); expect(pool[2]).toContain('$jevQuestionText:1');
});

it('keeps unpooled legacy question marker strings literal and returns caller-owned values', () => {
  const original = { instructions: 'This source quotes $jevQuestionText:0.', criteria: ['Original text'] };
  const result = resolveSharedQuestionTexts(original);
  expect(result).toEqual(original); expect(result).not.toBe(original); expect(result.criteria).not.toBe(original.criteria);
  expect(resolveSharedQuestionTexts('Symbolic $jevQuestionText:N', [])).toBe('Symbolic $jevQuestionText:N');
});

it.each([null, {}, [1], ['Valid text', null]])('rejects malformed question text pools (%s)', pool => {
  expect(() => resolveSharedQuestionTexts({ instructions: '$jevQuestionText:0' }, pool)).toThrow('Invalid synthetic provider question text pool');
});

it.each(['1', '9999999999999999999999999999999999999'])('rejects unknown or unsafe text reference indices (%s)', index => {
  expect(() => resolveSharedQuestionTexts({ instructions: `$jevQuestionText:${index}` }, ['One exact original text']))
    .toThrow('Invalid synthetic provider question text reference index');
});
