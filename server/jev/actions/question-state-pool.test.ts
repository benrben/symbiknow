import { expect, it } from 'vitest';
import { compileSharedQuestionStates, type SharedQuestionSourceState } from './question-state-pool.js';

const source: SharedQuestionSourceState = { id: 'alpha', title: '工程 · Alpha',
  passages: [{ id: 'p0', text: 'Alpha owns deployment. Keep exact “quotes”, /api, and \nline breaks.' }], coverage: .75 };
function hydrate(value: unknown, sources: SharedQuestionSourceState[]): unknown {
  if (Array.isArray(value)) return value.map(item => hydrate(item, sources));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  if (Object.hasOwn(input, '$jevSourceRef')) return structuredClone(sources[Number(input.$jevSourceRef)]);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, hydrate(item, sources)]));
}

it('replaces every occurrence of an exact source including the first without changing other values or property order', () => {
  const states = [{ source, context: { sources: [source, { document: source }], enabled: false, value: null, count: 0 } },
    { document: structuredClone(source), facts: ['ordinary text', 4, true] }];
  const original = structuredClone(states); const pooled = compileSharedQuestionStates(states);
  expect(pooled.sourceStates).toEqual([source]);
  expect(pooled.questionSets).toEqual([{ source: { $jevSourceRef: 0 }, context: {
    sources: [{ $jevSourceRef: 0 }, { document: { $jevSourceRef: 0 } }], enabled: false, value: null, count: 0 } },
  { document: { $jevSourceRef: 0 }, facts: ['ordinary text', 4, true] }]);
  expect(JSON.stringify(hydrate(pooled.questionSets, pooled.sourceStates))).toBe(JSON.stringify(states));
  expect(states).toEqual(original);
});

it.each(['id', 'title', 'passage id', 'text', 'coverage'] as const)
('never merges a source when its exact %s changes', change => {
  const other = structuredClone(source);
  if (change === 'id') other.id = 'beta';
  if (change === 'title') other.title = 'Beta';
  if (change === 'passage id') other.passages[0].id = 'p1';
  if (change === 'text') other.passages[0].text += ' New exact source fact.';
  if (change === 'coverage') other.coverage = .5;
  const states = [{ source }, { source: other }, { source }]; const pooled = compileSharedQuestionStates(states);
  expect(pooled.sourceStates).toEqual([source, other]);
  expect(pooled.questionSets.map(state => state.source)).toEqual([{ $jevSourceRef: 0 }, { $jevSourceRef: 1 }, { $jevSourceRef: 0 }]);
  expect(hydrate(pooled.questionSets, pooled.sourceStates)).toEqual(states);
});

it('does not infer equivalence from reordered keys or reordered passages and retains empty exact source states', () => {
  const reordered = { coverage: source.coverage, passages: source.passages, title: source.title, id: source.id };
  const first = { ...source, passages: [...source.passages, { id: 'p1', text: 'Second exact fact.' }] };
  const reverse = { ...first, passages: [...first.passages].reverse() };
  const empty = { id: 'empty', title: 'Empty', passages: [], coverage: 0 };
  const states = [{ source }, { source: reordered }, { source: first }, { source: reverse }, { source: empty }];
  const pooled = compileSharedQuestionStates(states);
  expect(pooled.sourceStates).toHaveLength(5);
  expect(JSON.stringify(hydrate(pooled.questionSets, pooled.sourceStates))).toBe(JSON.stringify(states));
});

it('preserves source lookalikes with missing, extra or invalid fields as ordinary JSON values', () => {
  const lookalikes = [{ ...source, extra: 'Keep me' }, { ...source, title: 3 }, { ...source, id: 8 },
    { id: source.id, title: source.title, passages: source.passages }, { ...source, coverage: -1 },
    { ...source, coverage: 1.01 }, { ...source, coverage: '1' }, { ...source, passages: 'passages' },
    { ...source, passages: [{ id: 'p0', text: 'Exact quote.', offset: 0 }] },
    { ...source, passages: [{ id: 0, text: 'Exact quote.' }] }, { ...source, passages: [{ id: 'p0', text: false }] },
    { ...source, passages: [null] }];
  const states = lookalikes.map(document => ({ document })); const pooled = compileSharedQuestionStates(states);
  expect(pooled.sourceStates).toEqual([]); expect(pooled.questionSets).toEqual(states);
});

it('owns independent mutable output values and matches ordinary SDK JSON projection for aliases and optional values', () => {
  const shared = { tags: ['manual'] }; const states = [{ source, shared, alias: shared,
    optional: undefined, array: [undefined, new Date('2026-10-04T12:00:00Z')] }];
  const pooled = compileSharedQuestionStates(states);
  expect(JSON.stringify(hydrate(pooled.questionSets, pooled.sourceStates))).toBe(JSON.stringify(states));
  pooled.sourceStates[0].passages[0].text = 'Caller edit';
  (pooled.questionSets[0].shared as { tags: string[] }).tags.push('Caller edit');
  expect(source.passages[0].text).toContain('Alpha owns'); expect(shared.tags).toEqual(['manual']);
  expect((pooled.questionSets[0].alias as { tags: string[] }).tags).toEqual(['manual']);
});

it.each([{ $jevSourceRef: 0 }, { $jevSourceRef: 99, other: 'malicious' }, { nested: [{ $jevSourceRef: null }] }])
('rejects original reserved marker objects instead of interpreting them as source evidence (%s)', value => {
  expect(() => compileSharedQuestionStates([{ source, untrusted: value }]))
    .toThrow('Jev source reference markers are reserved for compiled question states');
});

it('keeps marker-like text and ordinary sourceStates keys literal and makes empty input local', () => {
  const states = [{ sourceStates: ['ordinary value'], quote: '{"$jevSourceRef": 0}', nested: {} }];
  expect(compileSharedQuestionStates(states)).toEqual({ sourceStates: [], questionSets: states });
  expect(compileSharedQuestionStates([])).toEqual({ sourceStates: [], questionSets: [] });
});

it('surfaces unsupported JSON serialization rather than fabricating or truncating source data', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => compileSharedQuestionStates([cyclic])).toThrow(TypeError);
  expect(() => compileSharedQuestionStates([{ value: 1n }])).toThrow(TypeError);
});
