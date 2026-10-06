import { expect, it } from 'vitest';
import { createDerivedValueReader, decodeWorkspaceDerivedValues, derivedValuePoolFields, encodeWorkspaceDerivedValues,
  readDerivedValue, validateWorkspaceDerivedValues, type WorkspaceDerivedValuePool } from './workspace-derived-value-pool.js';
import { z } from 'zod';

const source = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source', incarnation: 'exact-incarnation',
  sourceGeneration: 1, metadataRevision: 2, contentHash: 'checked-source' };
const quote = 'Exact source evidence with original offsets, responsibility, and supporting context. '.repeat(5);
const recall = { passages: [{ source, quote, start: 3, end: 3 + quote.length }], conflicts: [], query: 'Checked responsibility' };
const rubric = { clarity: { score: 1, evidence: quote }, completeness: { score: 2, evidence: quote } };
const values = { role: 'reference', recall, keyPassages: [quote], linkRechecks: [{ source, quote, supported: true }],
  qualityRubric: rubric, scopedSources: [source], arbitrary: { $jevDerivedValue: 0, derivedValueReferences: ['literal'] } };
const mutation = { kind: 'derived', blockId: 'source', values };
type TestValues = typeof values;
type Fixture = { proposals: Array<{ mutation: typeof mutation }>; receipts: Array<{ before: typeof mutation; after: typeof mutation }>;
  prepared: Array<{ before: typeof mutation; after: typeof mutation; proposal: { mutation: typeof mutation } }>; profiles: Record<string, TestValues>; arbitrary: unknown };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture(): Fixture {
  return clone({ proposals: [{ mutation }], receipts: [{ before: mutation, after: mutation }],
    prepared: [{ before: mutation, after: mutation, proposal: { mutation } }], profiles: { 'canvas:source': values }, arbitrary: { mutation, values } });
}
function encoded() { return encodeWorkspaceDerivedValues(fixture()) as WorkspaceDerivedValuePool & { state: Fixture }; }
function restored() { const pool = encoded(); return decodeWorkspaceDerivedValues(pool.state, pool) as Fixture; }
function failure(state: unknown, pool: WorkspaceDerivedValuePool) {
  expect(() => validateWorkspaceDerivedValues(state, pool)).toThrowError(expect.objectContaining({ status: 503, message: 'Symbi Reflex workspace state requires recovery' }));
  expect(() => decodeWorkspaceDerivedValues(state, pool)).toThrowError(expect.objectContaining({ status: 503 }));
}

it('pools four exact controlled bodies across every supported history and live profile path without changing source vectors, literal markers or JSON order', () => {
  const state = fixture(); const before = JSON.stringify(state); const pool = encoded();
  expect(pool.derivedValues).toEqual([recall, [{ source, quote, supported: true }], rubric, [quote]]);
  expect(pool.derivedValueReferences).toHaveLength(28);
  expect(pool.state.proposals[0].mutation.values.scopedSources).toEqual([source]);
  expect(pool.state.proposals[0].mutation.values.recall).toBeNull();
  expect(pool.state.arbitrary).toEqual(state.arbitrary);
  expect(z.object(derivedValuePoolFields).safeParse(pool).success).toBe(true);
  expect(validateWorkspaceDerivedValues(pool.state, pool)).toBeUndefined();
  const decoded = decodeWorkspaceDerivedValues(pool.state, pool);
  expect(JSON.stringify(decoded)).toBe(before); expect(JSON.stringify(state)).toBe(before);
});

it('keeps small, unique, malformed-container and unrelated values inline without widening the controlled paths', () => {
  const state = { proposals: [null, { mutation: null }, { mutation: { kind: 'document', values } },
    { mutation: { kind: 'derived', values: null } }, { mutation: { kind: 'derived', values: { recall: undefined, keyPassages: ['small'], qualityRubric: { unique: quote } } } }],
    receipts: 'literal', prepared: [{ proposal: null, before: null, after: { kind: 'unknown', values } }], profiles: null };
  const pool = encodeWorkspaceDerivedValues(state); expect(pool.derivedValues).toEqual([]); expect(pool.derivedValueReferences).toEqual([]);
  expect(pool.state).toEqual(state); expect(decodeWorkspaceDerivedValues(pool.state, pool)).toEqual(state);
  for (const literal of [null, [], 3, { profiles: { absent: null } }, { proposals: false, prepared: false }, { profiles: ['literal'] }]) {
    const local = encodeWorkspaceDerivedValues(literal); expect(local.derivedValues).toEqual([]); expect(local.state).toEqual(literal);
    expect(validateWorkspaceDerivedValues(local.state, local)).toBeUndefined(); expect(decodeWorkspaceDerivedValues(local.state, local)).toEqual(literal);
  }
});

it('does not merge changed content, identities, property order or distributions', () => {
  const state = fixture(); state.receipts[0].before.values.recall.passages[0].source.incarnation = 'later-incarnation';
  state.receipts[0].after.values.recall.passages[0].quote += ' New exact source.';
  state.prepared[0].before.values.recall = { query: recall.query, conflicts: [], passages: clone(recall.passages) };
  state.prepared[0].after.values.qualityRubric.clarity.score = 3;
  const pool = encodeWorkspaceDerivedValues(state); expect(pool.derivedValues).toHaveLength(4);
  expect((pool.state as Fixture).receipts[0].before.values.recall).toEqual(state.receipts[0].before.values.recall);
  expect(JSON.stringify(decodeWorkspaceDerivedValues(pool.state, pool))).toBe(JSON.stringify(state));
});

it('owns dictionary snapshots and restores independent mutable values on first access at every occurrence', () => {
  const pool = encoded(); const original = clone(pool); const state = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  const descriptor = Object.getOwnPropertyDescriptor(state.proposals[0].mutation.values, 'recall')!;
  expect(descriptor.get).toBeTypeOf('function'); expect(descriptor).toMatchObject({ enumerable: true, configurable: true });
  (pool.derivedValues[0] as typeof recall).passages[0].quote = 'Caller changed the encoded dictionary';
  pool.derivedValueReferences[0].value = 3;
  state.proposals[0].mutation.values.recall.passages[0].quote = 'Only this occurrence was edited';
  expect(state.receipts[0].before.values.recall).toEqual(recall); expect(state.receipts[0].after.values.recall).toEqual(recall);
  expect(state.prepared[0].proposal.mutation.values.recall).toEqual(recall); expect(state.profiles['canvas:source'].recall).toEqual(recall);
  const plain = Object.getOwnPropertyDescriptor(state.proposals[0].mutation.values, 'recall')!;
  expect(plain).toMatchObject({ value: state.proposals[0].mutation.values.recall, writable: true, enumerable: true, configurable: true });
  expect((decodeWorkspaceDerivedValues(original.state, original) as Fixture).proposals[0].mutation.values.recall).toEqual(recall);
});

it('reencodes unread history without invoking its getters and preserves lazy values absent from an external reference table', () => {
  const pool = encoded(); const state = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  const descriptor = Object.getOwnPropertyDescriptor(state.receipts[0].before.values, 'recall');
  const again = encodeWorkspaceDerivedValues(state);
  expect(clone(again)).toEqual(clone(pool));
  expect(Object.getOwnPropertyDescriptor(state.receipts[0].before.values, 'recall')).toEqual(descriptor);
  const empty = { derivedValues: [], derivedValueReferences: [] };
  const retained = decodeWorkspaceDerivedValues(state, empty) as Fixture;
  expect(Object.getOwnPropertyDescriptor(state.receipts[0].before.values, 'recall')).toEqual(descriptor);
  expect(retained.receipts[0].before.values.recall).toEqual(recall);
  failure(state, pool);
});

it('serializes a changed or directly replaced body while unrelated unread values remain reusable', () => {
  const state = restored(); state.proposals[0].mutation.values.recall = { ...recall, query: 'A manual replacement' };
  state.receipts[0].before.values.recall.passages[0].quote = 'A later manual correction';
  const descriptor = Object.getOwnPropertyDescriptor(state.receipts[0].after.values, 'recall');
  const pool = encodeWorkspaceDerivedValues(state); const next = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  expect(next.proposals[0].mutation.values.recall.query).toBe('A manual replacement');
  expect(next.receipts[0].before.values.recall.passages[0].quote).toBe('A later manual correction');
  expect(next.receipts[0].after.values.recall).toEqual(recall);
  expect(Object.getOwnPropertyDescriptor(state.receipts[0].after.values, 'recall')).toEqual(descriptor);
});

it.each(['spread', 'structuredClone', 'JSON'])('preserves ordinary public serialization and independent values through %s', mode => {
  const state = restored(); const value = state.proposals[0].mutation.values;
  const plain = mode === 'spread' ? { ...value } : mode === 'JSON' ? clone(value) : structuredClone(value);
  expect(plain).toEqual(values); plain.recall.passages[0].quote = 'Edited caller copy';
  expect(state.receipts[0].before.values.recall).toEqual(recall);
});

it.each(['seal', 'freeze'])('retains lazy reads and native assignment behavior for %s', mode => {
  const state = restored(); const value = state.proposals[0].mutation.values;
  if (mode === 'seal') Object.seal(value); else Object.freeze(value);
  expect(value.recall).toEqual(recall); expect(value.recall).toBe(value.recall);
  expect(Object.getOwnPropertyDescriptor(value, 'recall')!.get).toBeTypeOf('function');
  const changed = { ...recall, query: 'Sealed replacement' };
  if (mode === 'seal') { value.recall = changed; expect(value.recall).toBe(changed); }
  else expect(() => { value.recall = changed; }).toThrow(TypeError);
  const pool = encodeWorkspaceDerivedValues(state); expect((decodeWorkspaceDerivedValues(pool.state, pool) as Fixture).proposals[0].mutation.values.recall).toEqual(value.recall);
});

it('recognizes only the original owned descriptor and respects deletion and non-enumerable replacement', () => {
  const state = restored(); const value = state.proposals[0].mutation.values;
  Object.defineProperty(value, 'recall', { get: () => ({ ...recall, query: 'External getter' }), enumerable: true, configurable: true });
  Object.defineProperty(state.receipts[0].before.values, 'recall', { value: recall, enumerable: false, configurable: true });
  const original = Object.getOwnPropertyDescriptor(state.receipts[0].after.values, 'recall')!;
  delete (state.receipts[0].after.values as Partial<TestValues>).recall;
  expect(original.get!()).toEqual(recall); expect(Object.hasOwn(state.receipts[0].after.values, 'recall')).toBe(false);
  const pool = encodeWorkspaceDerivedValues(state); const next = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  expect(next.proposals[0].mutation.values.recall.query).toBe('External getter');
  expect(Object.hasOwn(next.receipts[0].before.values, 'recall')).toBe(false); expect(Object.hasOwn(next.receipts[0].after.values, 'recall')).toBe(false);
});

it('returns only a requested small profile body through a reusable packet reader without hydrating historical slots', () => {
  const pool = encoded(); const state = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  const descriptor = Object.getOwnPropertyDescriptor(state.receipts[0].before.values, 'recall');
  const reader = createDerivedValueReader(pool.state, pool);
  const first = reader(['profiles', 'canvas:source', 'keyPassages'], null) as string[];
  expect(first).toEqual([quote]); first.push('Caller mutation');
  expect(reader(['profiles', 'canvas:source', 'keyPassages'], null)).toEqual([quote]);
  expect(readDerivedValue(pool.state, pool, ['profiles', 'canvas:source', 'keyPassages'])).toEqual([quote]);
  expect(readDerivedValue(pool.state, pool, ['profiles', 'canvas:source', 'role'])).toBe('reference');
  expect(readDerivedValue(pool.state, pool, ['profiles', 'missing', 'keyPassages'], 'fallback')).toBe('fallback');
  expect(readDerivedValue(null, { derivedValues: [], derivedValueReferences: [] }, ['profiles', 'missing'])).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(state.receipts[0].before.values, 'recall')).toEqual(descriptor);
});

it.each([
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences.push(clone(pool.derivedValueReferences[0])); },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].value = pool.derivedValues.length; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].value = -1; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].value = .5; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].path = ['arbitrary', 'values', 'recall']; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].path = ['proposals', 9, 'mutation', 'values', 'recall']; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValueReferences[0].path = ['proposals', 0, 'mutation', 'values', 'scopedSources']; },
  (pool: ReturnType<typeof encoded>) => { Object.assign(pool.derivedValueReferences[0], { unexpected: true }); },
  (pool: ReturnType<typeof encoded>) => { pool.state.proposals[0].mutation.values.recall = recall; },
  (pool: ReturnType<typeof encoded>) => { pool.state.proposals[0].mutation.kind = 'document' as never; },
  (pool: ReturnType<typeof encoded>) => { pool.state.proposals[0].mutation.values = null as never; },
  (pool: ReturnType<typeof encoded>) => { pool.state.profiles = [] as never; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValues = [undefined]; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValues = [NaN]; },
  (pool: ReturnType<typeof encoded>) => { pool.derivedValues = [() => 'invalid']; },
  (pool: ReturnType<typeof encoded>) => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; pool.derivedValues = [cycle]; },
])('rejects corrupt, duplicate, out-of-scope, non-placeholder or non-JSON references (%#)', corrupt => {
  const pool = encoded(); corrupt(pool); failure(pool.state, pool);
});

it('preserves a unique unread body without reading it and surfaces original unsupported serialization errors', () => {
  const pool = encoded(); const state = decodeWorkspaceDerivedValues(pool.state, pool) as Fixture;
  state.receipts = []; state.prepared = []; state.profiles = {};
  const descriptor = Object.getOwnPropertyDescriptor(state.proposals[0].mutation.values, 'recall');
  const next = encodeWorkspaceDerivedValues(state); expect(next.derivedValues).toEqual([]);
  expect(Object.getOwnPropertyDescriptor(state.proposals[0].mutation.values, 'recall')).toEqual(descriptor);
  expect(JSON.stringify(next.state)).toBe(JSON.stringify(state));
  const bad = fixture(); Object.assign(bad.proposals[0].mutation.values.recall, { unsupported: 1n });
  expect(() => encodeWorkspaceDerivedValues(bad)).toThrow(TypeError);
});
