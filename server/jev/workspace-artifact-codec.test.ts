import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { JevWorkspaceState } from '../../shared/jev-types.js';
import { decodeWorkspaceArtifacts, encodeWorkspaceArtifacts, validateWorkspaceArtifacts } from './workspace-artifact-codec.js';
import { decodeJevWorkspace, encodeJevWorkspace, validateJevWorkspacePool } from './workspace-codec.js';
import { emptyJevWorkspace } from './workspace.js';

const block = { id: 'first', title: 'First', file: 'docs/first.md', kind: 'document', x: 11, y: 22, width: 280, height: 180,
  links: ['second'], tags: ['manual'], jevOwnership: { pins: ['tags'], managed: ['group'], removedLabels: [], removedLinks: [] },
  arbitrary: { codec: 'jev-source-vectors', version: 2, blocks: [{ literal: true }], $jevCanvasBlock: 0 } };
const second = { ...block, id: 'second', file: 'docs/second.md', links: [], tags: [] };
const canvas = { id: 'canvas', name: 'Knowledge', workspaceId: 'workspace', blocks: [block, second, block] };
const artifact = { kind: 'canvas', id: 'canvas', before: canvas, after: canvas, reserved: canvas };
type TestCanvas = typeof canvas & Record<string, unknown>;
type TestArtifact = { kind: string; id: string; before: TestCanvas; after: TestCanvas; reserved: TestCanvas };
type ArtifactState = { receipts: Array<{ preparedArtifacts: TestArtifact[] }>; prepared: Array<{ artifacts: TestArtifact[] }> };
type TestEnvelope = { state: JevWorkspaceState & ArtifactState; blocks: Array<Record<string, unknown>>; blockVectors: number[][];
  blockReferences: Array<{ path: Array<string | number>; vector: number }>; sources: unknown[]; vectors: number[][];
  references: Array<{ path: Array<string | number>; vector: number }>; [field: string]: unknown };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture(): JevWorkspaceState {
  const state = emptyJevWorkspace();
  state.receipts = [{ id: 'receipt', preparedArtifacts: [artifact, { kind: 'content', id: 'first', before: 'Exact content', after: 'Exact content' }] }] as never;
  state.prepared = [{ id: 'prepared', artifacts: [artifact, { kind: 'tasks', id: 'canvas', before: [{ title: 'Manual work' }], after: [] }] }] as never;
  const payload = { schemaVersion: 1, id: 'reset', artifacts: [artifact], canvasIds: ['canvas'], documentCount: 2 };
  Object.assign(state, { resetJournal: { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') } });
  return state;
}
function encoded(): TestEnvelope { return clone(encodeJevWorkspace(fixture())) as TestEnvelope; }

it('reuses each immutable unread block vector once per encoding without restoring proof blocks', () => {
  const value = encoded(); const decoded = decodeWorkspaceArtifacts(value.state, value) as JevWorkspaceState & ArtifactState;
  const proof = decoded.receipts[0].preparedArtifacts[0].before;
  const descriptor = Object.getOwnPropertyDescriptor(proof, 'blocks');
  const stringify = JSON.stringify; let vectorSerializations = 0;
  const observer = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, spacing) => {
    if (Array.isArray(value) && value.length === 3 && value.every(item => Number.isInteger(item))) vectorSerializations++;
    return stringify(value, replacer as never, spacing);
  });
  try {
    const first = encodeWorkspaceArtifacts(decoded);
    expect(vectorSerializations).toBe(1);
    expect(first.blocks).toEqual(value.blocks); expect(first.blockVectors).toEqual(value.blockVectors);
    expect(first.blockReferences).toEqual(value.blockReferences);
    expect(Object.getOwnPropertyDescriptor(proof, 'blocks')).toEqual(descriptor);
    vectorSerializations = 0;
    const second = encodeWorkspaceArtifacts(decoded);
    expect(vectorSerializations).toBe(1); expect(second).toEqual(first);
    expect(Object.getOwnPropertyDescriptor(proof, 'blocks')).toEqual(descriptor);
  } finally { observer.mockRestore(); }
});

it('pools exact native canvas blocks and ordered vectors while preserving all source-free proof bytes and reset journal checksums', () => {
  const state = fixture(); const before = JSON.stringify(state); const value = encoded();
  expect(value).toMatchObject({ codec: 'jev-source-vectors', version: 2, sources: [], vectors: [], references: [] });
  expect(value.blocks).toEqual([block, second]); expect(value.blockVectors).toEqual([[0, 1, 0]]);
  expect(value.blockReferences).toHaveLength(6);
  expect(validateJevWorkspacePool(value)).toBeUndefined();
  const decoded = decodeJevWorkspace(value) as JevWorkspaceState;
  expect(JSON.stringify(decoded)).toBe(before); expect(JSON.stringify(state)).toBe(before);
  const journal = (decoded as JevWorkspaceState & { resetJournal: Record<string, unknown> }).resetJournal;
  const { checksum, ...payload } = journal;
  expect(createHash('sha256').update(JSON.stringify(payload)).digest('hex')).toBe(checksum);
  expect(JSON.stringify((value.state as unknown as JevWorkspaceState & { resetJournal: unknown }).resetJournal)).toBe(JSON.stringify(journal));
});

it('restores fresh nested blocks for every occurrence, side and history record without changing JSON key order', () => {
  const value = encoded(); const original = JSON.stringify(value); const decoded = decodeJevWorkspace(value) as JevWorkspaceState & ArtifactState;
  const receipt = decoded.receipts[0].preparedArtifacts[0]; const prepared = decoded.prepared[0].artifacts[0];
  receipt.before.blocks[0].jevOwnership.pins.push('group'); receipt.before.blocks[0].tags.push('caller edit');
  expect(receipt.before.blocks[2]).toEqual(block); expect(receipt.after.blocks[0]).toEqual(block);
  expect(receipt.reserved.blocks[0]).toEqual(block); expect(prepared.before.blocks[0]).toEqual(block);
  expect(JSON.stringify(value)).toBe(original); expect(decodeJevWorkspace(value)).toEqual(fixture());
});

it('re-encodes untouched proof descriptors without restoring their blocks and snapshots input dictionaries privately', () => {
  const value = encoded(); const original = clone(value); const decoded = decodeJevWorkspace(value) as JevWorkspaceState & ArtifactState;
  const canvas = decoded.receipts[0].preparedArtifacts[0].before; const descriptor = Object.getOwnPropertyDescriptor(canvas, 'blocks')!;
  expect(descriptor).toMatchObject({ enumerable: true, configurable: true }); expect(descriptor.get).toBeTypeOf('function');
  value.blocks[0].tags = ['Changed encoded input']; value.blockVectors[0][0] = 1;
  const next = clone(encodeJevWorkspace(decoded)); expect(next).toEqual(original);
  expect(Object.getOwnPropertyDescriptor(canvas, 'blocks')).toEqual(descriptor);
  const blocks = canvas.blocks; expect(blocks).toEqual([block, second, block]);
  expect(blocks[0]).not.toBe(blocks[2]); expect(blocks[0].jevOwnership).not.toBe(blocks[2].jevOwnership);
  expect(Object.getOwnPropertyDescriptor(canvas, 'blocks')).toEqual({ value: blocks, writable: true, enumerable: true, configurable: true });
});

it('rejects already restored nonempty placeholders and preserves unreferenced lazy proof values', () => {
  const pool = encodeWorkspaceArtifacts(fixture()); const restored = decodeWorkspaceArtifacts(pool.state, pool) as JevWorkspaceState & ArtifactState;
  expect(() => validateWorkspaceArtifacts(restored, pool)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => decodeWorkspaceArtifacts(restored, pool)).toThrowError(expect.objectContaining({ status: 503 }));
  const literal = { blocks: [], blockVectors: [], blockReferences: [] };
  const retained = decodeWorkspaceArtifacts(restored, literal) as JevWorkspaceState & ArtifactState;
  expect(retained.receipts[0].preparedArtifacts[0].before.blocks).toEqual([block, second, block]);
});

it.each(['spread', 'JSON', 'structuredClone'])('materializes ordinary independent values through %s without changing proof JSON', operation => {
  const decoded = decodeJevWorkspace(encoded()) as JevWorkspaceState & ArtifactState; const native = decoded.receipts[0].preparedArtifacts[0].before;
  let copy: unknown;
  if (operation === 'spread') copy = { ...native };
  else if (operation === 'JSON') copy = JSON.parse(JSON.stringify(native));
  else copy = structuredClone(native);
  expect(JSON.stringify(copy)).toBe(JSON.stringify(canvas));
  expect(Object.getOwnPropertyDescriptor(native, 'blocks')).toMatchObject({ value: [block, second, block], writable: true });
  expect(decoded.receipts[0].preparedArtifacts[0].after.blocks).toEqual([block, second, block]);
});

it('serializes a directly assigned block array and a changed native descriptor rather than reusing unread history', () => {
  const decoded = decodeJevWorkspace(encoded()) as JevWorkspaceState & ArtifactState; const proof = decoded.receipts[0].preparedArtifacts[0];
  const replacement = [{ ...block, tags: ['Replacement'], x: 50 }]; proof.before.blocks = replacement;
  expect(Object.getOwnPropertyDescriptor(proof.before, 'blocks')).toEqual({ value: replacement, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(proof.after, 'blocks', { value: [{ ...block, tags: ['New descriptor'] }], writable: true, enumerable: true, configurable: true });
  const restored = decodeJevWorkspace(clone(encodeJevWorkspace(decoded))) as JevWorkspaceState & ArtifactState;
  expect(restored.receipts[0].preparedArtifacts[0].before.blocks).toEqual(replacement);
  expect(restored.receipts[0].preparedArtifacts[0].after.blocks[0].tags).toEqual(['New descriptor']);
  expect(restored.receipts[0].preparedArtifacts[0].reserved.blocks).toEqual([block, second, block]);
});

it('respects user replacements of getter or setter descriptors and preserves hidden or removed properties', () => {
  const decoded = decodeJevWorkspace(encoded()) as JevWorkspaceState & ArtifactState; const proof = decoded.receipts[0].preparedArtifacts[0];
  const replacement = [{ ...block, tags: ['Custom getter'] }]; const ownSetter = () => undefined;
  Object.defineProperty(proof.before, 'blocks', { get: () => replacement, set: ownSetter, enumerable: true, configurable: true });
  Object.defineProperty(proof.after, 'blocks', { set: ownSetter });
  const restored = decodeJevWorkspace(clone(encodeJevWorkspace(decoded))) as JevWorkspaceState & ArtifactState;
  expect(restored.receipts[0].preparedArtifacts[0].before.blocks).toEqual(replacement);
  expect(Object.getOwnPropertyDescriptor(proof.after, 'blocks')!.set).toBe(ownSetter);
  expect(Object.getOwnPropertyDescriptor(proof.after, 'blocks')!.get).toBeTypeOf('function');
  Object.defineProperty(proof.reserved, 'blocks', { enumerable: false });
  const hidden = clone(encodeJevWorkspace(decoded)) as TestEnvelope;
  expect(hidden.state.receipts[0].preparedArtifacts[0].reserved).not.toHaveProperty('blocks');
  delete (proof.reserved as Partial<TestCanvas>).blocks; proof.reserved.future = 'Literal future metadata';
  expect(JSON.stringify(decodeJevWorkspace(clone(encodeJevWorkspace(decoded))))).toContain('Literal future metadata');
});

it('preserves readable and mutable nested values on sealed and frozen proof canvases without invalid descriptor replacement', () => {
  const decoded = decodeJevWorkspace(encoded()) as JevWorkspaceState & ArtifactState; const proof = decoded.receipts[0].preparedArtifacts[0];
  Object.seal(proof.before); const firstRead = proof.before.blocks; expect(proof.before.blocks).toBe(firstRead);
  firstRead[0].tags.push('Nested sealed edit');
  proof.before.blocks = [{ ...block, tags: ['Sealed replacement'] }]; expect(proof.before.blocks[0].tags).toEqual(['Sealed replacement']);
  Object.freeze(proof.after); expect(proof.after.blocks).toEqual([block, second, block]);
  expect(() => { proof.after.blocks = []; }).toThrow(TypeError);
  proof.after.blocks[0].tags.push('Nested frozen edit');
  const restored = decodeJevWorkspace(clone(encodeJevWorkspace(decoded))) as JevWorkspaceState & ArtifactState;
  expect(restored.receipts[0].preparedArtifacts[0].before.blocks[0].tags).toEqual(['Sealed replacement']);
  expect(restored.receipts[0].preparedArtifacts[0].after.blocks[0].tags).toEqual(['manual', 'Nested frozen edit']);
  expect(restored.receipts[0].preparedArtifacts[0].reserved.blocks).toEqual([block, second, block]);
});

it('keeps differing manual metadata, positions, revisions, order, multiplicity and property ordering distinct', () => {
  const variants = [block, { ...block, tags: ['other manual tag'] }, { ...block, x: 12 },
    { ...block, sourceGeneration: 2 }, { ...block, metadataRevision: 3 }, Object.fromEntries([['file', block.file], ...Object.entries(block)])];
  const state = emptyJevWorkspace();
  state.receipts = variants.map(item => ({ preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: [item] } }] })) as never;
  state.receipts.push({ preparedArtifacts: [{ ...artifact, before: { ...canvas, blocks: variants }, after: { ...canvas, blocks: [...variants].reverse() } }] } as never);
  const value = clone(encodeJevWorkspace(state)) as TestEnvelope;
  expect(value.blocks).toHaveLength(7); expect(value.blockVectors).toHaveLength(9);
  expect(JSON.stringify(decodeJevWorkspace(value))).toBe(JSON.stringify(state));
});

it('combines artifact pooling with version 1 source vectors and keeps legacy source-only envelopes readable', () => {
  const state = fixture(); const source = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'first', incarnation: 'original',
    sourceGeneration: 1, metadataRevision: 0, contentHash: 'hash' };
  state.profiles['canvas:first'] = { scopedSources: [source], role: 'reference' };
  const value = clone(encodeJevWorkspace(state)); expect(value).toHaveProperty('version', 2);
  expect(decodeJevWorkspace(value)).toEqual(state); expect(validateJevWorkspacePool(value)).toBeUndefined();
  const legacy = emptyJevWorkspace(); legacy.profiles['canvas:first'] = state.profiles['canvas:first'];
  const sourceOnly = clone(encodeJevWorkspace(legacy)); expect(sourceOnly).toHaveProperty('version', 1);
  expect(decodeJevWorkspace(sourceOnly)).toEqual(legacy);
});

it('preserves literal malformed or future containers and non-source blocks without reinterpreting arbitrary JSON', () => {
  const values = [null, [], 4, { receipts: 'future data', prepared: 'future data' },
    { receipts: [null, [], 4, { preparedArtifacts: 'literal' }, { preparedArtifacts: [null, [], 5, { kind: 'tasks' },
      { kind: 'canvas', id: 5, before: canvas }, { kind: 'canvas', id: 'canvas', before: { ...canvas, extra: 'future' } },
      { kind: 'canvas', id: 'canvas', before: { ...canvas, name: 4 } }, { kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: 'future' } },
      { kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: [] } }, { kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: [null] } },
      { kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: [{ id: 3, file: 'doc.md' }] } },
      { kind: 'canvas', id: 'canvas', before: { ...canvas, blocks: [{ id: 'id', file: 3 }] } },
    ] }], prepared: [{ artifacts: [] }] }];
  for (const value of values) {
    const pool = encodeWorkspaceArtifacts(value); expect(pool.blockReferences).toEqual([]);
    expect(decodeWorkspaceArtifacts(pool.state, pool)).toEqual(value); expect(validateWorkspaceArtifacts(pool.state, pool)).toBeUndefined();
  }
  const state = emptyJevWorkspace(); Object.assign(state, { codec: 'jev-source-vectors', version: 2, blocks: [block], blockReferences: [] });
  expect(decodeJevWorkspace(state)).toBe(state); expect(validateJevWorkspacePool(state)).toBeUndefined();
});

it('preserves unusual nested JSON keys and does not mutate object prototypes through block dictionaries', () => {
  const state = fixture() as unknown as JevWorkspaceState & ArtifactState; const unusual = JSON.parse('{"id":"first","file":"docs/first.md","__proto__":{"manual":true},"constructor":{"literal":true}}');
  state.receipts[0].preparedArtifacts[0].after = { ...canvas, blocks: [unusual] };
  expect(JSON.stringify(decodeJevWorkspace(clone(encodeJevWorkspace(state))))).toBe(JSON.stringify(state));
  expect({}).not.toHaveProperty('manual');
});

it.each([
  ['invalid block', (value: TestEnvelope) => { value.blocks[0].id = 7; }],
  ['dangling block', (value: TestEnvelope) => { value.blockVectors[0] = [99]; }],
  ['negative block index', (value: TestEnvelope) => { value.blockVectors[0] = [-1]; }],
  ['fractional block index', (value: TestEnvelope) => { value.blockVectors[0] = [0.5]; }],
  ['dangling vector', (value: TestEnvelope) => { value.blockReferences[0].vector = 99; }],
  ['duplicate path', (value: TestEnvelope) => { value.blockReferences.push(value.blockReferences[0]); }],
  ['unknown root path', (value: TestEnvelope) => { value.blockReferences[0].path[0] = 'resetJournal'; }],
  ['wrong artifact field', (value: TestEnvelope) => { value.blockReferences[0].path[2] = 'artifacts'; }],
  ['negative record index', (value: TestEnvelope) => { value.blockReferences[0].path[1] = -1; }],
  ['wrong side', (value: TestEnvelope) => { value.blockReferences[0].path[4] = '__proto__'; }],
  ['unknown block field', (value: TestEnvelope) => { value.blockReferences[0].path[5] = 'tags'; }],
  ['dangling record path', (value: TestEnvelope) => { value.blockReferences[0].path[1] = 99; }],
  ['dangling artifact path', (value: TestEnvelope) => { value.blockReferences[0].path[3] = 99; }],
  ['non-canvas artifact', (value: TestEnvelope) => { value.state.receipts[0].preparedArtifacts[0].kind = 'tasks'; }],
  ['wrong canvas shape', (value: TestEnvelope) => { value.state.receipts[0].preparedArtifacts[0].before.extra = true; }],
  ['nonempty placeholder', (value: TestEnvelope) => { value.state.receipts[0].preparedArtifacts[0].before.blocks.push(block); }],
  ['nonarray placeholder', (value: TestEnvelope) => { value.state.receipts[0].preparedArtifacts[0].before.blocks = null as never; }],
  ['unknown envelope field', (value: TestEnvelope) => { value.future = true; }],
  ['malformed source path', (value: TestEnvelope) => { value.sources = [{ workspaceId: 'w', canvasId: 'c', blockId: 'b', incarnation: 'i', sourceGeneration: 1, metadataRevision: 0, contentHash: 'h' }]; value.vectors = [[0]]; value.references = [{ path: ['settings', 'people'], vector: 0 }]; }],
] as const)('rejects %s before hydrating history or accepting an optional cache packet', (_name, mutate) => {
  const value = encoded(); mutate(value);
  expect(() => decodeJevWorkspace(value)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => validateJevWorkspacePool(value)).toThrowError(expect.objectContaining({ status: 503 }));
});
