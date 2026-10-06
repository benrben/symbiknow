import { expect, it } from 'vitest';
import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { installWorkspaceSourceVectors, unreadWorkspaceSourceVector, type WorkspaceSourceVectorReference } from './workspace-lazy-source-vectors.js';

const first: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'first', incarnation: 'exact-original',
  sourceGeneration: 1, metadataRevision: 2, contentHash: 'original-source-hash' };
const second = { ...first, blockId: 'second', incarnation: 'second-original', metadataRevision: 3 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type State = { jobs: Array<{ label: string; sources: JevSourceSnapshot[]; exact: string }>;
  profiles: Record<string, { role: string; scopedSources: JevSourceSnapshot[] }> };
function fixture(): State {
  return { jobs: [{ label: 'First', sources: [], exact: 'Untouched\r\nUnicode café' },
    { label: 'Second', sources: [], exact: 'Separate source guard' }], profiles: { 'canvas:first': { role: 'reference', scopedSources: [] } } };
}
const references: WorkspaceSourceVectorReference[] = [
  { path: ['jobs', 0, 'sources'], vector: 0 }, { path: ['jobs', 1, 'sources'], vector: 0 },
  { path: ['profiles', 'canvas:first', 'scopedSources'], vector: 1 },
];
function installed() { return installWorkspaceSourceVectors(fixture(), [first, second], [[0, 1, 0], [1, 0]], references); }

it('installs unread immutable plans, preserving property order and exact source JSON until independently materialized', () => {
  const state = fixture(); const result = installWorkspaceSourceVectors(state, [first, second], [[0, 1, 0], [1, 0]], references);
  expect(result).toBe(state);
  expect(Object.keys(state.jobs[0])).toEqual(['label', 'sources', 'exact']);
  const plan = unreadWorkspaceSourceVector(state.jobs[0], 'sources')!;
  const other = unreadWorkspaceSourceVector(state.jobs[1], 'sources')!;
  const reverse = unreadWorkspaceSourceVector(state.profiles['canvas:first'], 'scopedSources')!;
  expect(plan).toBe(other); expect(plan.indices).toBe(other.indices); expect(reverse.indices).not.toBe(plan.indices);
  expect(reverse.sourceTexts).toBe(plan.sourceTexts);
  expect(plan).toEqual({ sourceTexts: [JSON.stringify(first), JSON.stringify(second)], indices: [0, 1, 0] });
  expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.sourceTexts)).toBe(true); expect(Object.isFrozen(plan.indices)).toBe(true);
  expect(() => { (plan.indices as number[])[0] = 99; }).toThrow(TypeError);
  const descriptor = Object.getOwnPropertyDescriptor(state.jobs[0], 'sources')!;
  expect(descriptor).toMatchObject({ get: expect.any(Function), set: expect.any(Function), enumerable: true, configurable: true });
  const expected = fixture(); expected.jobs[0].sources = [first, second, first]; expected.jobs[1].sources = [first, second, first];
  expected.profiles['canvas:first'].scopedSources = [second, first];
  expect(JSON.stringify(state)).toBe(JSON.stringify(expected));
  expect(unreadWorkspaceSourceVector(state.jobs[0], 'sources')).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(state.jobs[0], 'sources')).toEqual({ value: state.jobs[0].sources,
    writable: true, enumerable: true, configurable: true });
});

it('copies source dictionaries and vector indices before callers can change any encoded input', () => {
  const sources = clone([first, second]); const vectors = [[0, 1, 0], [1, 0]]; const refs = clone(references);
  const state = installWorkspaceSourceVectors(fixture(), sources, vectors, refs);
  sources[0].incarnation = 'Changed encoded input'; sources.push({ ...first, blockId: 'new' });
  vectors[0][0] = 1; vectors[0].push(99); vectors[1].reverse(); refs[0].vector = 1;
  expect(state.jobs[0].sources).toEqual([first, second, first]); expect(state.profiles['canvas:first'].scopedSources).toEqual([second, first]);
});

it('tracks several independent guarded fields on one owner without materializing another field', () => {
  const state = { jobs: [{ sources: [], contextSources: [], followupSources: [] }] };
  installWorkspaceSourceVectors(state, [first, second], [[0], [0, 1]], [
    { path: ['jobs', 0, 'sources'], vector: 0 }, { path: ['jobs', 0, 'contextSources'], vector: 1 },
    { path: ['jobs', 0, 'followupSources'], vector: 1 },
  ]);
  const contextPlan = unreadWorkspaceSourceVector(state.jobs[0], 'contextSources');
  expect(state.jobs[0].sources).toEqual([first]);
  expect(unreadWorkspaceSourceVector(state.jobs[0], 'contextSources')).toBe(contextPlan);
  expect(unreadWorkspaceSourceVector(state.jobs[0], 'followupSources')).toBe(contextPlan);
});

it('owns each array and each repeated snapshot independently while preserving ordinary mutable array behavior', () => {
  const state = installed(); const sources = state.jobs[0].sources;
  expect(state.jobs[0].sources).toBe(sources); expect(sources[0]).not.toBe(sources[2]);
  sources[0].metadataRevision = 9; sources.push({ ...first, blockId: 'caller-added' });
  expect(sources[2]).toEqual(first); expect(state.jobs[1].sources).toEqual([first, second, first]);
  expect(state.profiles['canvas:first'].scopedSources).toEqual([second, first]); expect(first.metadataRevision).toBe(2);
  state.jobs[1].sources.reverse(); expect(sources[1]).toEqual(second);
});

it('preserves direct assignment as an ordinary owned replacement without materializing the original plan', () => {
  const state = installed(); const other = unreadWorkspaceSourceVector(state.jobs[1], 'sources'); const replacement = [clone(second)];
  state.jobs[0].sources = replacement;
  expect(state.jobs[0].sources).toBe(replacement); expect(unreadWorkspaceSourceVector(state.jobs[0], 'sources')).toBeUndefined();
  expect(unreadWorkspaceSourceVector(state.jobs[1], 'sources')).toBe(other);
  replacement[0].metadataRevision = 44; expect(state.jobs[0].sources[0].metadataRevision).toBe(44);
  expect(state.jobs[1].sources).toEqual([first, second, first]);
});

it.each(['seal', 'freeze'] as const)('preserves %s reads and original native assignment semantics', mode => {
  const state = installed(); const owner = state.jobs[0];
  if (mode === 'seal') Object.seal(owner); else Object.freeze(owner);
  expect(unreadWorkspaceSourceVector(owner, 'sources')).toBeUndefined();
  const sources = owner.sources; expect(sources).toEqual([first, second, first]); expect(owner.sources).toBe(sources);
  expect(Object.getOwnPropertyDescriptor(owner, 'sources')!.get).toBeTypeOf('function');
  expect(unreadWorkspaceSourceVector(owner, 'sources')).toBeUndefined();
  const replacement = [clone(second)];
  if (mode === 'seal') { owner.sources = replacement; expect(owner.sources).toBe(replacement); }
  else expect(() => { owner.sources = replacement; }).toThrow(TypeError);
  expect(state.jobs[1].sources).toEqual([first, second, first]);
});

it('recognizes only exact original descriptors, never copied, externally replaced, nonenumerable or deleted fields', () => {
  const state = installed(); const owner = state.jobs[0]; const descriptor = Object.getOwnPropertyDescriptor(owner, 'sources')!;
  expect(unreadWorkspaceSourceVector({}, 'sources')).toBeUndefined();
  const external = {}; Object.defineProperty(external, 'sources', descriptor);
  expect(unreadWorkspaceSourceVector(external, 'sources')).toBeUndefined();
  Object.defineProperty(owner, 'sources', { get: () => [second], enumerable: true, configurable: true });
  expect(unreadWorkspaceSourceVector(owner, 'sources')).toBeUndefined(); expect(owner.sources).toEqual([second]);
  Object.defineProperty(state.jobs[1], 'sources', { value: [first], enumerable: false, configurable: true });
  expect(unreadWorkspaceSourceVector(state.jobs[1], 'sources')).toBeUndefined();
  delete (state.profiles['canvas:first'] as Partial<State['profiles'][string]>).scopedSources;
  expect(unreadWorkspaceSourceVector(state.profiles['canvas:first'], 'scopedSources')).toBeUndefined();
  expect(descriptor.get!()).toEqual([first, second, first]); expect(owner.sources).toEqual([second]);
});

it.each(['JSON', 'structuredClone', 'spread'] as const)('produces ordinary independent values through public %s serialization', mode => {
  const state = installed(); const owner = state.jobs[0];
  const copy = mode === 'JSON' ? clone(owner) : mode === 'structuredClone' ? structuredClone(owner) : { ...owner };
  expect(copy.sources).toEqual([first, second, first]); expect(copy.exact).toBe('Untouched\r\nUnicode café');
  copy.sources[0].metadataRevision = 90;
  expect(state.jobs[1].sources).toEqual([first, second, first]);
});

it('supports empty vectors and unusual owned profile keys without treating inherited properties as writable slots', () => {
  const state = { profiles: JSON.parse('{"__proto__":{"scopedSources":[]},"a.b[0]":{"scopedSources":[]}}') };
  installWorkspaceSourceVectors(state, [], [[]], [{ path: ['profiles', '__proto__', 'scopedSources'], vector: 0 },
    { path: ['profiles', 'a.b[0]', 'scopedSources'], vector: 0 }]);
  expect(state.profiles.__proto__.scopedSources).toEqual([]); expect(state.profiles['a.b[0]'].scopedSources).toEqual([]);
  expect({}).not.toHaveProperty('scopedSources');
  expect(installWorkspaceSourceVectors(null, [], [], [])).toBeNull();
});

it.each([
  ['absent parent', {}, ['jobs', 0, 'sources'], 0],
  ['primitive parent', { jobs: 1 }, ['jobs', 0, 'sources'], 0],
  ['null final owner', { jobs: [null] }, ['jobs', 0, 'sources'], 0],
  ['absent final slot', { jobs: [{}] }, ['jobs', 0, 'sources'], 0],
  ['numeric final field', { jobs: [[]] }, ['jobs', 0, 0], 0],
  ['empty path', {}, [], 0],
  ['inherited property', {}, ['__proto__', 'sources'], 0],
  ['missing vector', fixture(), ['jobs', 0, 'sources'], 9],
] as const)('rejects an inconsistent already-validated installation (%s) without fabricating empty guards', (_description, state, path, vector) => {
  expect(() => installWorkspaceSourceVectors(state, [first], [[0]], [{ path, vector }]))
    .toThrowError(expect.objectContaining({ status: 503, message: 'Symbi Reflex workspace state requires recovery' }));
});
