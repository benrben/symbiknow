import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { JevJson, JevMutation, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { decodeJevWorkspace, encodeJevWorkspace } from './workspace-codec.js';
import { emptyJevWorkspace } from './workspace.js';

const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'block',
  incarnation: 'incarnation', sourceGeneration: 1, metadataRevision: 2, contentHash: 'hash' };
const vectors = [source, { ...source, blockId: 'second' }, source];
const json = (value: unknown): JevJson => value as JevJson;
const derived: JevMutation = { kind: 'derived', blockId: 'block', values: { scopedSources: json(vectors), role: 'reference' } };
function proposal(): JevProposal {
  return { id: 'proposal', jobId: 'job', action: 'profile', title: 'Profile', explanation: 'Exact source', confidence: 0.99,
    evidence: [{ source, start: 0, end: 6, quote: 'Source' }], sources: vectors, mutation: derived,
    state: 'applied', createdAt: '2026-10-04T00:00:00Z' };
}
function fixture(): JevWorkspaceState {
  const state = emptyJevWorkspace(); const time = '2026-10-04T00:00:00Z';
  state.jobs = [{ id: 'job', request: { action: 'profile', canvasId: 'canvas', blockIds: ['block'] }, sources: vectors,
    state: 'completed', createdAt: time, updatedAt: time, proposalIds: ['proposal'],
    contextSources: vectors, followupSources: vectors, result: { marker: { $jevSourceVector: 0 } } } as never];
  state.proposals = [proposal(), { ...proposal(), id: 'document', mutation: { kind: 'document', canvasId: 'canvas', blockId: 'block', patch: { tags: ['manual'] } } }];
  const native = { codec: 'jev-source-vectors', version: 1, sources: vectors, scopedSources: vectors,
    unknown: { $jevSourceVector: 0 }, content: '# Native source\nReferences must stay literal.' };
  state.receipts = [{ id: 'receipt', proposalId: 'proposal', action: 'profile', actor: 'automation', state: 'applied',
    createdAt: time, before: derived, after: derived, sourcesAfter: vectors,
    preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: native, after: native }] } as never];
  state.profiles['canvas:block'] = { source: json(source), scopedSources: json(vectors), role: 'reference',
    arbitrary: { $jevSourceVector: 0, codec: 'jev-source-vectors', vectors: json(vectors) } };
  state.prepared = [{ id: 'prepared', proposal: proposal(), before: derived, after: derived, artifacts: [native] } as never];
  const payload = { schemaVersion: 1, id: 'reset', artifacts: [native], vocabularyAfter: [], canvasIds: ['canvas'], documentCount: 2 };
  Object.assign(state, { resetJournal: { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') } });
  return state;
}
function serialized(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
function envelope(): Record<string, unknown> { return serialized(encodeJevWorkspace(fixture())) as Record<string, unknown>; }

it('pools exact snapshots and vectors at every defined path while retaining native proof and arbitrary JSON', () => {
  const state = fixture(); const original = JSON.stringify(state); const encoded = envelope();
  expect(encoded.sources).toHaveLength(2); expect(encoded.vectors).toEqual([[0, 1, 0]]);
  expect(encoded.references).toHaveLength(14);
  const decoded = decodeJevWorkspace(encoded) as JevWorkspaceState;
  expect(decoded).toEqual(state); expect(JSON.stringify(state)).toBe(original);
  const plain = encoded.state as JevWorkspaceState & { resetJournal: unknown };
  expect(plain.jobs[0].sources).toEqual([]);
  expect(JSON.stringify(plain.resetJournal)).toBe(JSON.stringify((state as JevWorkspaceState & { resetJournal: unknown }).resetJournal));
  expect(JSON.stringify((plain.receipts[0] as unknown as { preparedArtifacts: unknown }).preparedArtifacts))
    .toBe(JSON.stringify((state.receipts[0] as unknown as { preparedArtifacts: unknown }).preparedArtifacts));
  expect(plain.proposals[0].evidence).toEqual(state.proposals[0].evidence);
  const journal = (decoded as JevWorkspaceState & { resetJournal: Record<string, unknown> }).resetJournal;
  const { checksum, ...payload } = journal;
  expect(createHash('sha256').update(JSON.stringify(payload)).digest('hex')).toBe(checksum);
});

it('hydrates independent mutable snapshots and arrays for live state, history, and repeated elements', () => {
  const decoded = decodeJevWorkspace(envelope()) as JevWorkspaceState;
  const profile = decoded.profiles['canvas:block'].scopedSources as unknown as JevSourceSnapshot[];
  decoded.jobs[0].sources[0].metadataRevision = 9; decoded.jobs[0].sources.push({ ...source, blockId: 'new' });
  expect(decoded.jobs[0].sources[2].metadataRevision).toBe(2);
  expect(decoded.proposals[0].sources).toEqual(vectors); expect(decoded.receipts[0].sourcesAfter).toEqual(vectors); expect(profile).toEqual(vectors);
  profile[1].contentHash = 'changed';
  expect((decoded.proposals[0].mutation as Extract<JevMutation, { kind: 'derived' }>).values.scopedSources).toEqual(vectors);
  expect(decodeJevWorkspace(envelope())).toEqual(fixture());
});

it('distinguishes metadata revisions, source generations, incarnations, content hashes, ordering and duplicate entries', () => {
  const state = emptyJevWorkspace();
  const variants = [source, { ...source, metadataRevision: 3 }, { ...source, sourceGeneration: 2 },
    { ...source, incarnation: 'replacement' }, { ...source, contentHash: 'edited' }];
  state.profiles = Object.fromEntries(variants.map((item, index) => [`source-${index}`, { scopedSources: json([item]) }]));
  state.profiles.forward = { scopedSources: json(variants) };
  state.profiles.reverse = { scopedSources: json([...variants].reverse()) };
  const encoded = serialized(encodeJevWorkspace(state)) as Record<string, unknown>;
  expect(encoded.sources).toHaveLength(5); expect(encoded.vectors).toHaveLength(7);
  expect(decodeJevWorkspace(encoded)).toEqual(state);
});

it('keeps legacy states and literal reference-like objects authoritative without reinterpretation', () => {
  const state = emptyJevWorkspace(); Object.assign(state, { codec: 'jev-source-vectors', version: 999, references: [{ path: ['profiles'], vector: 0 }] });
  state.profiles.literal = { scopedSources: [{ $jevSourceVector: 0 }], arbitrary: { codec: 'jev-source-vectors', version: 1 } };
  expect(encodeJevWorkspace(state)).toBe(state); expect(decodeJevWorkspace(state)).toBe(state);
  expect(decodeJevWorkspace(serialized(state))).toEqual(state);
});

it('preserves incomplete, extended and non-source arrays and missing optional fields exactly', () => {
  const invalid = [null, [], { ...source, extra: 'future data' }, { ...source, workspaceId: 1 },
    { ...source, sourceGeneration: -1 }, { ...source, metadataRevision: 0.5 }];
  for (const item of invalid) {
    const state = emptyJevWorkspace(); state.profiles.legacy = { scopedSources: json([item]) };
    expect(encodeJevWorkspace(state)).toBe(state); expect(decodeJevWorkspace(serialized(state))).toEqual(state);
  }
  const state = emptyJevWorkspace();
  state.jobs = [null, [], { sources: 'unknown', contextSources: [], followupSources: [source] }] as never;
  state.proposals = [{ mutation: null }, { mutation: { kind: 'derived' } }, { mutation: { kind: 'derived', values: null } }] as never;
  state.receipts = [{ before: { kind: 'derived', values: [] }, after: null }] as never;
  state.prepared = [{ proposal: null, before: null, after: null }] as never;
  Object.assign(state.profiles, { absent: {}, null: null, primitive: 42, array: [] });
  expect(decodeJevWorkspace(serialized(encodeJevWorkspace(state)))).toEqual(state);
  for (const field of ['jobs', 'proposals', 'receipts', 'profiles', 'prepared']) {
    const malformed = { ...emptyJevWorkspace(), [field]: 'preserved', unknown: { scopedSources: vectors } } as unknown as JevWorkspaceState;
    expect(encodeJevWorkspace(malformed)).toBe(malformed);
  }
});

it.each([null, [], {}, { codec: 'jev-source-vectors', version: 2 }, { codec: 'other', version: 1 }])
('refuses unsupported or malformed codec envelopes: %j', value => {
  expect(() => decodeJevWorkspace(value)).toThrowError(expect.objectContaining({ status: 503 }));
});

it.each([
  ['invalid snapshot', (value: Record<string, unknown>) => { value.sources = [{ ...source, extra: true }]; }],
  ['negative snapshot counter', (value: Record<string, unknown>) => { value.sources = [{ ...source, sourceGeneration: -1 }]; }],
  ['dangling source', (value: Record<string, unknown>) => { value.vectors = [[99]]; }],
  ['negative source index', (value: Record<string, unknown>) => { value.vectors = [[-1]]; }],
  ['fractional source index', (value: Record<string, unknown>) => { value.vectors = [[0.5]]; }],
  ['dangling vector', (value: Record<string, unknown>) => { value.references = [{ path: ['jobs', 0, 'sources'], vector: 99 }]; }],
  ['duplicate path', (value: Record<string, unknown>) => { const refs = value.references as unknown[]; refs.push(refs[0]); }],
  ['unknown path', (value: Record<string, unknown>) => { value.references = [{ path: ['settings', '__proto__'], vector: 0 }]; }],
  ['nonempty placeholder', (value: Record<string, unknown>) => { (value.state as JevWorkspaceState).jobs[0].sources.push(source); }],
  ['invalid placeholder', (value: Record<string, unknown>) => { (value.state as JevWorkspaceState).jobs[0].sources = null as never; }],
  ['unknown envelope field', (value: Record<string, unknown>) => { value.future = true; }],
] as const)('fails closed for %s without interpreting arbitrary recovery artifacts', (_description, mutate) => {
  const value = envelope(); mutate(value);
  expect(() => decodeJevWorkspace(value)).toThrowError(expect.objectContaining({ status: 503 }));
  expect({}).not.toHaveProperty('metadataRevision');
});

it('retains unusual profile keys without mutating object prototypes or confusing path spelling', () => {
  const state = emptyJevWorkspace(); state.profiles = JSON.parse('{"__proto__":{},"a.b[0]":{}}');
  state.profiles.__proto__.scopedSources = json(vectors); state.profiles['a.b[0]'].scopedSources = json(vectors);
  expect(decodeJevWorkspace(serialized(encodeJevWorkspace(state)))).toEqual(state);
  expect({}).not.toHaveProperty('scopedSources');
});
