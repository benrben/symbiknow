import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JevJson, JevMutation, JevProposal, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import type { StoredJevReceipt } from './proposals.js';
import type { StoredJevJob } from './runtime-queue.js';
import { checkedJevWorkspaceValueReader, decodeJevWorkspace, encodeJevWorkspace, validateJevWorkspacePool } from './workspace-codec.js';
import type { WorkspaceDerivedValuePool } from './workspace-derived-value-pool.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

const content = '# Native evidence\r\nExact source: café & <code>/api</code>. '.repeat(5);
const quote = content.slice(0, content.length - 1);
const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
  incarnation: 'unchanged-incarnation', sourceGeneration: 1, metadataRevision: 2, contentHash: 'exact-source-hash' };
const json = (value: unknown): JevJson => value as JevJson;
const time = '2026-10-04T12:00:00Z';
type Derived = Extract<JevMutation, { kind: 'derived' }>;
type Envelope = WorkspaceDerivedValuePool & { version: number; state: JevWorkspaceState; sources: JevSourceSnapshot[];
  blocks: Array<Record<string, unknown>>; blockVectors: number[][]; blockReferences: Array<{ path: Array<string | number>; vector: number }> };
let root: string; let files: JevWorkspaceFiles;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-derived-codec-integration-')); files = new JevWorkspaceFiles(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(): JevWorkspaceState {
  const state = emptyJevWorkspace();
  const passage = { source: json(source), quote, start: 0, end: quote.length };
  const values = { role: 'reference', keyPassages: [quote, 'A second exact passage'], recall: { query: 'Native evidence', passages: [passage] },
    qualityRubric: { clarity: { score: 3, evidence: passage } }, linkRechecks: [{ source: json(source), quote, supported: true }],
    scopedSources: [json(source)] };
  const mutation: Derived = { kind: 'derived', blockId: source.blockId, values };
  const proposal: JevProposal = { id: 'analysis', jobId: 'profile-job', action: 'profile', title: 'Checked analysis', explanation: 'Exact original evidence',
    confidence: .99, evidence: [{ source, start: 0, end: quote.length, quote }], sources: [source], mutation, state: 'applied', createdAt: time };
  state.proposals = [proposal];
  const canvas = { id: 'canvas', name: 'Native proof', workspaceId: 'workspace', blocks: [{ id: 'source', title: 'Native evidence',
    file: 'docs/source.md', kind: 'markdown' as const, content, tags: ['Manual'], group: 'custom:manual', x: 123, y: 456,
    width: 400, height: 300, links: [] }] };
  state.receipts = [{ id: 'receipt', proposalId: proposal.id, action: 'profile', state: 'applied', actor: automationPrincipal.id,
    createdAt: time, before: mutation, after: mutation, sourcesAfter: [source],
    preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: canvas, after: canvas }] } as StoredJevReceipt];
  state.profiles['canvas:source'] = values;
  state.prepared = [{ id: 'prepared', proposal, before: mutation, after: mutation }];
  state.jobs = [{ id: 'queued', request: { action: 'profile', canvasId: 'canvas', blockIds: ['source'] }, state: 'queued',
    createdAt: time, updatedAt: time, sources: [source], contextSources: [source], followupSources: [source],
    proposalIds: [], attempts: 0, settingsKey: 'settings', authorizationFingerprint: 'automatic', principal: automationPrincipal } as StoredJevJob];
  return JSON.parse(JSON.stringify(state)) as JevWorkspaceState;
}
function envelope(state = fixture()): Envelope { return JSON.parse(JSON.stringify(encodeJevWorkspace(state))) as Envelope; }
function values(state: JevWorkspaceState, side: 'before' | 'after' = 'after') { return (state.receipts[0][side] as Derived).values; }
async function replace(value: unknown): Promise<string> {
  const file = files.file('workspace'); await mkdir(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(value); await writeFile(file, bytes, { mode: 0o600 }); return bytes;
}

it.each([undefined, NaN, Infinity, () => 'unsupported', Symbol('unsupported'), 1n])
('rejects unsupported JSON dictionary data even when no derived reference uses it: %s', invalid => {
  const encoded = envelope(); encoded.derivedValues.push({ nested: [invalid] });
  expect(() => validateJevWorkspacePool(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => checkedJevWorkspaceValueReader(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => decodeJevWorkspace(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
});

it('composes V3 source, proof and derived pools losslessly and reencodes unread history without materializing it', () => {
  const state = fixture(); const original = JSON.stringify(state); const encoded = envelope(state);
  expect(encoded.version).toBe(3); expect(encoded.sources).toEqual([source]); expect(encoded.blocks).toHaveLength(1);
  expect(encoded.derivedValues).toHaveLength(4); expect(encoded.derivedValueReferences).toHaveLength(28);
  expect(encoded.state.profiles['canvas:source']).toMatchObject({ keyPassages: null, scopedSources: [] });
  expect(validateJevWorkspacePool(encoded)).toBeUndefined();
  const decoded = decodeJevWorkspace(encoded) as JevWorkspaceState;
  const historical = values(decoded, 'before'); const descriptor = Object.getOwnPropertyDescriptor(historical, 'recall');
  const proof = (decoded.receipts[0] as StoredJevReceipt).preparedArtifacts![0];
  if (proof.kind !== 'canvas') throw new Error('The fixture must retain a native canvas proof');
  const blockDescriptor = Object.getOwnPropertyDescriptor(proof.before, 'blocks');
  expect(descriptor?.get).toBeTypeOf('function'); expect(blockDescriptor?.get).toBeTypeOf('function');
  expect(envelope(decoded)).toEqual(encoded);
  expect(Object.getOwnPropertyDescriptor(historical, 'recall')).toEqual(descriptor);
  expect(Object.getOwnPropertyDescriptor(proof.before, 'blocks')).toEqual(blockDescriptor);
  expect(JSON.stringify(decoded)).toBe(original); expect(JSON.stringify(state)).toBe(original);
  expect(decoded.jobs[0].sources).toEqual([source]); expect(proof.before.blocks[0]).toMatchObject({ content, tags: ['Manual'], group: 'custom:manual', x: 123, y: 456 });
});

it('keeps decoded V3 history, live profiles and input dictionaries independent through edits and a real disk reload', async () => {
  const encoded = envelope(); const decoded = decodeJevWorkspace(encoded) as JevWorkspaceState;
  encoded.derivedValues[0] = { callerChanged: true }; encoded.blocks[0].tags = ['Caller changed input'];
  const after = values(decoded); (after.keyPassages as string[]).push('Only this occurrence');
  (after.recall as { query: string }).query = 'Only this receipt changed';
  expect(decoded.profiles['canvas:source'].keyPassages).toEqual([quote, 'A second exact passage']);
  expect((values(decoded, 'before').recall as { query: string }).query).toBe('Native evidence');
  await files.write('workspace', decoded);
  const reopened = await new JevWorkspaceFiles(root).read('workspace');
  expect(values(reopened).keyPassages).toEqual([quote, 'A second exact passage', 'Only this occurrence']);
  expect((values(reopened).recall as { query: string }).query).toBe('Only this receipt changed');
  expect(reopened.profiles['canvas:source']).toEqual(fixture().profiles['canvas:source']);
  expect(reopened.proposals[0].evidence[0]).toEqual({ source, start: 0, end: quote.length, quote });
  const proof = (reopened.receipts[0] as StoredJevReceipt).preparedArtifacts![0];
  if (proof.kind !== 'canvas') throw new Error('The persisted proof must remain a canvas artifact');
  expect(proof.before.blocks[0]).toMatchObject({ content, tags: ['Manual'], x: 123, y: 456 });
});

it('reads pooled live passages and queued sources directly from fresh V3 disk packets while full history remains exact', async () => {
  const state = fixture(); const encoded = envelope(state); const bytes = await replace(encoded);
  const progress = (await files.readProgress('workspace'))!; const queued = await files.readQueued('workspace');
  expect(progress.profiles).toEqual({ 'canvas:source': { role: 'reference', keyPassages: [quote] } });
  expect(progress.proposals).toEqual([]); expect(progress.receipts).toEqual([]);
  expect(queued).toHaveLength(1); expect(queued[0].sources).toEqual([source]);
  expect(queued[0]).not.toHaveProperty('contextSources'); expect(queued[0]).not.toHaveProperty('followupSources');
  progress.profiles['canvas:source'].keyPassages = ['Caller changed progress']; queued[0].sources[0].incarnation = 'Caller changed queue';
  expect((await new JevWorkspaceFiles(root).readProgress('workspace'))!.profiles['canvas:source'].keyPassages).toEqual([quote]);
  expect((await files.readQueued('workspace'))[0].sources).toEqual([source]);
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(bytes);
  const canonical = await files.read('workspace'); expect(JSON.stringify(canonical)).toBe(JSON.stringify(state));
  expect(Object.getOwnPropertyDescriptor(values(await files.read('workspace')), 'recall')?.get).toBeTypeOf('function');
});

it('reads V3 profiles without keyPassages and leaves their absent field absent in the full canonical ledger', async () => {
  const state = fixture(); delete state.profiles['canvas:source'].keyPassages;
  state.profiles['canvas:legacy'] = { role: 'reference', keyPassages: 'Legacy non-array passage' };
  const encoded = envelope(state); expect(encoded.version).toBe(3); await replace(encoded);
  expect((await files.readProgress('workspace'))!.profiles).toEqual({ 'canvas:source': { role: 'reference', keyPassages: [] },
    'canvas:legacy': { role: 'reference', keyPassages: [] } });
  const canonical = await files.read('workspace');
  expect(canonical.profiles['canvas:source']).not.toHaveProperty('keyPassages'); expect(canonical).toEqual(state);
});

it.each([
  ['missing V3 dictionary', (value: Envelope) => { delete (value as Partial<Envelope>).derivedValues; }],
  ['unknown V3 envelope field', (value: Envelope) => { Object.assign(value, { futureDerivedPool: true }); }],
  ['duplicate derived path', (value: Envelope) => { value.derivedValueReferences.push(value.derivedValueReferences[0]); }],
  ['dangling derived index', (value: Envelope) => { value.derivedValueReferences[0].value = value.derivedValues.length; }],
  ['unknown derived slot', (value: Envelope) => { value.derivedValueReferences[0].path = ['profiles', 'canvas:source', 'scopedSources']; }],
  ['non-placeholder live profile', (value: Envelope) => { value.state.profiles['canvas:source'].keyPassages = [quote]; }],
  ['dangling V3 artifact vector', (value: Envelope) => { value.blockVectors[0] = [value.blocks.length]; }],
] as const)('rejects %s through full and compact disk readers without modifying recovery bytes', async (_description, corrupt) => {
  const encoded = envelope(); corrupt(encoded);
  expect(() => validateJevWorkspacePool(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => checkedJevWorkspaceValueReader(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => decodeJevWorkspace(encoded)).toThrowError(expect.objectContaining({ status: 503 }));
  const bytes = await replace(encoded);
  for (const read of [() => files.read('workspace'), () => files.readProgress('workspace'), () => files.readQueued('workspace')]) {
    await expect(read()).rejects.toMatchObject({ status: 503, message: 'Symbi Reflex workspace state requires recovery' });
  }
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(bytes);
});
