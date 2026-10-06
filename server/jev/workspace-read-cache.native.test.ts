import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevJob, JevJson, JevMutation, JevProposal, JevReceipt, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { atomicJson } from '../storage-files.js';
import { automationPrincipal, scopedState } from './authorization.js';
import { withoutOriginMigrations } from './approval-origin.js';
import { compactJevState } from './compact-state.js';
import { withoutJevResetJournal } from './reset.js';
import type { StoredJevJob } from './runtime-queue.js';
import { encodeJevWorkspace } from './workspace-codec.js';
import * as workspaceCodec from './workspace-codec.js';
import { WorkspacePacketCache } from './workspace-packet-cache.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-read-cache-')); files = new JevWorkspaceFiles(root); });
afterEach(async () => { vi.restoreAllMocks(); first.metadataRevision = 0; await rm(root, { recursive: true, force: true }); });
const first: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'first', incarnation: 'original',
  sourceGeneration: 1, metadataRevision: 0, contentHash: 'first-hash' };
const second = { ...first, blockId: 'second', contentHash: 'second-hash' };
const time = '2026-10-04T00:00:00Z';
const json = (value: unknown): JevJson => value as JevJson;
function job(id: string, state: JevJob['state'] = 'queued'): StoredJevJob {
  return { id, request: { action: 'profile', canvasId: 'canvas', blockIds: ['first'] }, state, createdAt: time, updatedAt: time,
    sources: [first], contextSources: [first, second], principal: automationPrincipal, attempts: 0, settingsKey: 'settings',
    authorizationFingerprint: 'authorization', proposalIds: [], result: { status: 'profiled', analysis: 'Private result' } };
}
function proposal(id: string, mutation: JevMutation): JevProposal {
  return { id, jobId: 'job', action: 'file', title: 'Native source change', explanation: 'Checked', createdAt: time,
    sources: [first], evidence: [], mutation, state: 'applied' };
}
function fixture(): JevWorkspaceState {
  const state = emptyJevWorkspace(); const text = 'Exact native evidence '.repeat(5000);
  const document: JevMutation = { kind: 'document', canvasId: 'canvas', blockId: 'first', patch: { tags: [text] } };
  const content: JevMutation = { kind: 'content', canvasId: 'canvas', blockId: 'second', content: text, expectedContentHash: 'hash', draftId: 'draft' };
  const move: JevMutation = { kind: 'move', canvasId: 'canvas', blockId: 'second', targetCanvasId: 'other' };
  const vocabulary: JevMutation = { kind: 'vocabulary', operation: 'define', term: { id: 'atlas', kind: 'group', name: 'Atlas',
    definition: 'A reviewed topic', aliases: [], state: 'active', version: 1, members: [{ canvasId: 'canvas', blockId: 'first' }] } };
  const derived: JevMutation = { kind: 'derived', blockId: 'first', values: { scopedSources: json([first, second]), analysis: text } };
  const mutations = [document, content, move, vocabulary, derived, document];
  state.proposals = mutations.map((mutation, index) => proposal(`proposal-${index}`, mutation));
  state.proposals[5].jobId = 'origin-migration:receipt-original';
  state.receipts = mutations.map((mutation, index) => ({ id: `receipt-${index}`, proposalId: `proposal-${index}`, action: 'file',
    state: 'applied', actor: 'automatic', createdAt: time, before: mutation, after: mutation, sourcesAfter: [first],
    preparedArtifacts: [{ kind: 'content', before: text, after: text }], ownershipOriginalAfter: { content: text } } as JevReceipt));
  state.receipts.push({ ...state.receipts[0], id: 'orphan', proposalId: 'missing-proposal' });
  state.jobs = [job('queued'), job('running', 'running'), job('completed', 'completed')];
  Object.assign(state.jobs[0], { followupSources: [first, second] });
  state.jobs[2].result = { status: 'analyzed', privateAnalysis: text };
  state.profiles['canvas:first'] = { role: 'reference', keyPassages: ['Short checked quote', text], scopedSources: json([first, second]),
    scopedCanvasIds: ['canvas', 'other'], source: json(first), privateAnalysis: text };
  state.profiles['canvas:legacy'] = { keyPassages: 'Legacy text' };
  state.profiles['canvas:invalid-scope'] = { role: 'secret', scopedCanvasIds: [1] };
  state.vocabulary = [vocabulary.term]; state.suppressions = ['manual-correction'];
  state.prepared = [{ id: 'prepared', proposal: state.proposals[0], before: document, after: document }];
  state.commandPlans = []; Object.assign(state, { resetJournal: { artifacts: [{ before: text, after: text }] } });
  return state;
}
function ownerProgress(state: JevWorkspaceState): JevWorkspaceState {
  return compactJevState(withoutOriginMigrations(scopedState(withoutJevResetJournal(state), automationPrincipal)));
}
function queued(state: JevWorkspaceState): StoredJevJob[] {
  return state.jobs.filter(job => job.state === 'queued').map(job => {
    const copy = { ...job } as StoredJevJob & { followupSources?: JevSourceSnapshot[] };
    delete copy.result; delete copy.contextSources; delete copy.followupSources;
    return copy;
  });
}

it('caches only independent public owner progress and queued admission fields while canonical reads retain every native proof', async () => {
  const state = fixture(); await files.write('workspace', state);
  const canonical = await files.read('workspace'); const progress = (await files.readProgress('workspace'))!; const pending = await files.readQueued('workspace');
  expect(progress).toEqual(ownerProgress(canonical)); expect(pending).toEqual(queued(canonical));
  expect(progress.receipts.map(receipt => receipt.id)).toEqual(['receipt-0', 'receipt-1', 'receipt-2', 'receipt-3']);
  expect(progress.profiles).not.toHaveProperty('canvas:invalid-scope');
  expect(progress).not.toHaveProperty('resetJournal'); expect(JSON.stringify(progress)).not.toContain('Exact native evidence');
  expect(pending[0]).not.toHaveProperty('contextSources'); expect(pending[0]).not.toHaveProperty('followupSources'); expect(pending[0]).not.toHaveProperty('result');
  expect(JSON.stringify(progress).length).toBeLessThan(JSON.stringify(canonical).length / 50);
  progress.jobs[0].request.blockIds!.push('other'); progress.profiles['canvas:first'].role = 'caller change';
  pending[0].sources[0].metadataRevision = 99; pending[0].principal.access = 'read';
  expect(await new JevWorkspaceFiles(root).readProgress('workspace')).toEqual(ownerProgress(canonical));
  expect(await new JevWorkspaceFiles(root).readQueued('workspace')).toEqual(queued(canonical));
  expect(await files.read('workspace')).toEqual(canonical);
});

it('rebuilds projections for atomic external replacements and same-inode equal-size edits with the original mtime restored', async () => {
  await files.write('workspace', fixture()); const file = files.file('workspace');
  const fixed = new Date('2026-10-04T00:00:00Z'); await utimes(file, fixed, fixed);
  expect((await files.readProgress('workspace'))!.profiles['canvas:first'].role).toBe('reference');
  const before = await stat(file); const raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace('"role":"reference"', '"role":"decisions"')); await utimes(file, fixed, fixed);
  const after = await stat(file); expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
  expect((await files.readProgress('workspace'))!.profiles['canvas:first'].role).toBe('decisions');
  const replacement = fixture(); replacement.jobs[0].sources = [{ ...first, incarnation: 'replacement', sourceGeneration: 2 }];
  replacement.profiles['canvas:first'].role = 'external'; await atomicJson(file, encodeJevWorkspace(replacement), 0o600, 0);
  expect((await files.readQueued('workspace'))[0].sources[0]).toMatchObject({ incarnation: 'replacement', sourceGeneration: 2 });
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(await files.read('workspace')));
});

it('snapshots the exact encoded payload when callers mutate source arrays, profiles and requests before asynchronous serialization', async () => {
  const state = fixture(); const original = state.jobs[0].sources[0];
  const pending = files.write('workspace', state);
  state.jobs[0].sources[0] = { ...first, contentHash: 'caller replacement' };
  original.metadataRevision = 7; state.jobs[0].request.query = 'After the write call'; state.profiles['canvas:first'].role = 'caller mutation';
  await pending;
  const durable = await files.read('workspace');
  expect(durable.profiles['canvas:first'].role).toBe('reference');
  expect(durable.jobs[0].request.query).toBe('After the write call');
  expect(durable.jobs[0].sources[0]).toMatchObject({ metadataRevision: 7, contentHash: 'first-hash' });
  expect(await files.readQueued('workspace')).toEqual(queued(durable)); expect(await files.readProgress('workspace')).toEqual(ownerProgress(durable));
  original.metadataRevision = 0;
});

it('retains literal future source fields and empty vectors alongside pooled vectors and missing job results', async () => {
  const state = fixture();
  state.jobs[0].sources = [{ ...first, future: 'Literal source metadata' } as JevSourceSnapshot];
  state.receipts[0].sourcesAfter = []; delete state.jobs[2].result;
  await files.write('workspace', state);
  const durable = await files.read('workspace');
  expect(await files.readQueued('workspace')).toEqual(queued(durable));
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(durable));
  expect((await files.readProgress('workspace'))!.jobs[2].result).toEqual({ status: null,
    progressOutcome: { state: 'no_change', reason: 'No supported change' } });
});

it('declines to cache malformed pooled snapshots changed before serialization and preserves canonical recovery errors', async () => {
  const pending = files.write('workspace', fixture()); first.metadataRevision = -1;
  await pending; first.metadataRevision = 0;
  await expect(files.read('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
});

it('validates native block dictionaries before seeding a packet and detects malformed external artifact references', async () => {
  const state = fixture(); const block = { id: 'first', file: 'docs/first.md', tags: ['Manual tag'] };
  const canvas = { id: 'canvas', name: 'Knowledge', workspaceId: 'workspace', blocks: [block] };
  Object.assign(state.receipts[0], { preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: canvas, after: canvas }] });
  const pending = files.write('workspace', state); block.id = 3 as never; await pending;
  await expect(files.read('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
  block.id = 'first'; await files.write('workspace', state);
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(await files.read('workspace')));
  const file = files.file('workspace'); const encoded = JSON.parse(await readFile(file, 'utf8'));
  encoded.blockReferences[0].path[4] = 'Unknown artifact side'; await writeFile(file, JSON.stringify(encoded));
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
});

it('returns fresh valid progress even when its retained quote exceeds the bounded cache capacity', async () => {
  const state = emptyJevWorkspace(); const quote = 'x'.repeat(17 * 1024 * 1024);
  state.profiles['canvas:first'] = { role: 'reference', keyPassages: [quote] };
  await files.write('workspace', state);
  const progress = (await files.readProgress('workspace'))!;
  expect(progress.profiles['canvas:first'].keyPassages).toEqual([quote]);
  progress.profiles['canvas:first'].role = 'Caller mutation';
  expect((await files.readProgress('workspace'))!.profiles['canvas:first'].role).toBe('reference');
  expect(await files.readQueued('workspace')).toEqual([]);
});

it('commits no new cache packet after a real atomic-write failure and returns fresh empty state after deletion', async () => {
  await files.write('workspace', fixture()); const file = files.file('workspace'); const previous = await files.readProgress('workspace');
  const saved = await readFile(file, 'utf8'); await rename(file, file + '.backup'); await mkdir(file);
  const changed = fixture(); changed.profiles['canvas:first'].role = 'uncommitted';
  await expect(files.write('workspace', changed)).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.serial('workspace', () => files.read('workspace'))).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ code: 'EISDIR' });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ code: 'EISDIR' });
  expect((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await rm(file, { recursive: true }); await rename(file + '.backup', file);
  expect(await readFile(file, 'utf8')).toBe(saved); expect(await files.readProgress('workspace')).toEqual(previous);
  expect(await files.serial('workspace', () => files.readProgress('workspace'))).toEqual(previous);
  await unlink(file); expect(await files.readQueued('workspace')).toEqual([]);
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(emptyJevWorkspace()));
});

it.each(['invalid JSON', 'invalid codec', 'invalid settings', 'invalid vocabulary', 'invalid schema'])
('never serves a cached valid packet after %s and keeps canonical recovery failures visible', async failure => {
  const state = fixture(); await files.write('workspace', state); await files.readProgress('workspace'); const file = files.file('workspace');
  if (failure === 'invalid JSON') await writeFile(file, '{broken');
  else if (failure === 'invalid codec') await writeFile(file, JSON.stringify({ codec: 'jev-source-vectors', version: 99 }));
  else {
    const broken = fixture();
    if (failure === 'invalid settings') broken.settings.people = [{ id: '', name: 'Invalid', role: '' }];
    if (failure === 'invalid vocabulary') broken.vocabulary = [{ id: 'broken' }] as never;
    if (failure === 'invalid schema') broken.schemaVersion = 2 as never;
    await files.write('workspace', broken);
  }
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.read('workspace')).rejects.toMatchObject({ status: 503 });
  await files.write('workspace', fixture()); expect(await files.readProgress('workspace')).toEqual(ownerProgress(await files.read('workspace')));
});

it.each(['suppressions', 'prepared', 'schedules'])('validates original %s before sanitizing the optional cached progress view', async field => {
  await files.write('workspace', fixture()); const invalid = fixture();
  if (field === 'schedules') invalid.settings.schedules = 'Invalid original schedule shape' as never;
  else Object.assign(invalid, { [field]: 'Invalid original workspace shape' });
  await files.write('workspace', invalid);
  await expect(files.read('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
});

it('migrates retired queued actions before caching admission and does not confuse legacy literal codec fields with envelopes', async () => {
  const state = fixture(); state.jobs.push({ ...job('retired'), request: { action: 'set_headline', canvasId: 'canvas', blockIds: ['first'] } });
  await files.write('workspace', state);
  expect((await files.readProgress('workspace'))!.jobs.find(item => item.id === 'retired')?.state).toBe('cancelled');
  expect((await files.readQueued('workspace')).map(item => item.id)).toEqual(['queued']);
  const legacy = emptyJevWorkspace(); Object.assign(legacy, { codec: 'jev-source-vectors', state: { literal: true } });
  await files.write('workspace', legacy);
  expect(await files.readQueued('workspace')).toEqual([]); expect(await files.readProgress('workspace')).toBeUndefined();
  await expect(files.readQueued('../outside')).rejects.toMatchObject({ status: 400 });
});

it('passes exact serialized bytes to observers once and preserves the previous durable file when an observer fails', async () => {
  const file = path.join(root, 'observed.json'); let bytes = ''; let observed = 0;
  await atomicJson(file, { quote: 'Unicode ✔\nExact lines', value: 3 }, 0o600, 0, content => { observed++; bytes = content; });
  expect(observed).toBe(1); expect(await readFile(file, 'utf8')).toBe(bytes);
  await expect(atomicJson(file, { replaced: true }, 0o600, 0, () => { throw new Error('Observer failed'); })).rejects.toThrow('Observer failed');
  expect(await readFile(file, 'utf8')).toBe(bytes); expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

function demandHistory(): JevWorkspaceState {
  // Independent caller-owned objects retain the existing source, prepared and private-history proof matrix.
  const state = structuredClone(fixture());
  const quote = '# Exact native evidence';
  const passage = { source: json({ ...first }), quote, start: 0, end: quote.length };
  const values = { scopedSources: json([first, second]), keyPassages: [quote, 'Second retained quote'],
    recall: { query: 'Exact native evidence', passages: [passage] },
    qualityRubric: { clarity: { score: 3, evidence: passage } },
    linkRechecks: [{ source: json({ ...second }), quote, supported: true }] };
  const mutation: JevMutation = { kind: 'derived', blockId: 'first', values };
  state.proposals[4].mutation = structuredClone(mutation);
  state.proposals[4].evidence = [{ source: { ...first }, start: 0, end: quote.length, quote }];
  state.receipts[4].before = structuredClone(mutation); state.receipts[4].after = structuredClone(mutation);
  Object.assign(state.profiles['canvas:first'], structuredClone(values));
  const canvas = { id: 'canvas', name: 'Retained native proof', workspaceId: 'workspace', blocks: [
    { id: 'first', title: 'Exact native evidence', file: 'docs/first.md', kind: 'markdown' as const,
      content: '# Exact native evidence\r\nKeep café & <code>/api</code> byte-exact.\r\n',
      tags: ['Manual tag'], group: 'custom:manual', reviewer: 'Manual reviewer',
      x: 123, y: 456, width: 400, height: 300, links: [] },
  ] };
  Object.assign(state.receipts[0], { preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: canvas, after: canvas }] });
  state.jobs.push(...Array.from({ length: 64 }, (_, index) => ({ ...structuredClone(job(`retained-${index}`, 'completed')),
    contextSources: [{ ...first }, { ...second }], result: { status: 'analyzed', privateAnalysis: 'Private retained evidence' } })));
  return state;
}
function expectV3DemandHistory(raw: string): void {
  const encoded = JSON.parse(raw) as { codec: string; version: number; sources: JevSourceSnapshot[];
    references: unknown[]; blockReferences: unknown[]; derivedValueReferences: unknown[] };
  expect(encoded).toMatchObject({ codec: 'jev-source-vectors', version: 3 });
  expect(encoded.sources.length).toBeGreaterThanOrEqual(2);
  expect(encoded.references.length).toBeGreaterThan(64);
  expect(encoded.blockReferences).toHaveLength(2);
  expect(encoded.derivedValueReferences.length).toBeGreaterThan(0);
}

it('defers checked packet creation across serial durable V3 writes and reads exact committed proofs independently of callers', async () => {
  const validate = vi.spyOn(workspaceCodec, 'checkedJevWorkspaceValueReader');
  const cache = vi.spyOn(WorkspacePacketCache.prototype, 'set');
  const initial = demandHistory(); await files.write('workspace', initial);
  // Warm a previous independent projection before later revisions replace it.
  expect(await files.readQueued('workspace')).toEqual(queued(await files.read('workspace')));
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(await files.read('workspace')));
  validate.mockClear(); cache.mockClear();

  let finalCaller = initial; let expected = initial;
  for (const revision of [1, 2, 3]) {
    await files.serial('workspace', async () => {
      const caller = await files.read('workspace');
      caller.profiles['canvas:first'].role = `durable-${revision}`;
      caller.jobs[0].request.query = `Durable request ${revision}`;
      expected = JSON.parse(JSON.stringify(caller)) as JevWorkspaceState;
      expected.revision += 1;
      await files.write('workspace', caller);
      finalCaller = caller;
    });
  }
  // Mutation immediately after the final durable write must not become the first packet's source.
  finalCaller.jobs[0].sources[0].contentHash = 'Caller changed the committed source';
  (finalCaller.jobs[0] as StoredJevJob).principal.access = 'read'; finalCaller.jobs[0].request.query = 'Caller changed the request';
  finalCaller.profiles['canvas:first'].role = 'Caller changed the profile';
  finalCaller.receipts[4].after = { kind: 'derived', values: { callerChanged: true } };
  finalCaller.prepared.length = 0;
  expect(validate).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();

  const raw = await readFile(files.file('workspace'), 'utf8'); expectV3DemandHistory(raw);
  const canonical = await new JevWorkspaceFiles(root).read('workspace');
  expect(canonical).toEqual(expected); expect(canonical.revision).toBe(4);
  expect(canonical.proposals[4].evidence).toEqual(initial.proposals[4].evidence);
  expect(canonical.receipts[4]).toEqual(expected.receipts[4]); expect(canonical.prepared).toEqual(expected.prepared);
  // A canonical read remains independent and must not eagerly construct the public packet either.
  expect(validate).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
  const pending = await files.readQueued('workspace');
  expect(pending).toEqual(queued(canonical)); expect(validate).toHaveBeenCalledTimes(1); expect(cache).toHaveBeenCalledTimes(1);
  const progress = (await files.readProgress('workspace'))!;
  expect(progress).toEqual(ownerProgress(canonical)); expect(validate).toHaveBeenCalledTimes(1); expect(cache).toHaveBeenCalledTimes(1);
  pending[0].sources[0].incarnation = 'Caller changed returned source'; pending[0].principal.access = 'read';
  progress.jobs[0].request.blockIds!.push('Caller changed returned request'); progress.profiles['canvas:first'].role = 'Caller changed returned role';
  expect(await new JevWorkspaceFiles(root).readQueued('workspace')).toEqual(queued(canonical));
  expect(await new JevWorkspaceFiles(root).readProgress('workspace')).toEqual(ownerProgress(canonical));
  expect(await new JevWorkspaceFiles(root).read('workspace')).toEqual(expected);
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(raw);
  expect(validate).toHaveBeenCalledTimes(1); expect(cache).toHaveBeenCalledTimes(1);
});

it('builds its first packet from a valid external durable replacement rather than the last successful write input', async () => {
  const validate = vi.spyOn(workspaceCodec, 'checkedJevWorkspaceValueReader');
  const cache = vi.spyOn(WorkspacePacketCache.prototype, 'set');
  const state = demandHistory(); await files.write('workspace', state); await files.readProgress('workspace');
  validate.mockClear(); cache.mockClear();
  state.profiles['canvas:first'].role = 'Last successful write'; await files.write('workspace', state);
  expect(validate).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
  const replacement = demandHistory(); replacement.revision = state.revision + 7;
  replacement.profiles['canvas:first'].role = 'External durable replacement';
  replacement.jobs[0].sources = [{ ...first, incarnation: 'external-incarnation', sourceGeneration: 8, contentHash: 'external-source-hash' }];
  await atomicJson(files.file('workspace'), encodeJevWorkspace(replacement), 0o600, 0);
  const raw = await readFile(files.file('workspace'), 'utf8'); expectV3DemandHistory(raw);
  const canonical = await new JevWorkspaceFiles(root).read('workspace'); expect(canonical).toEqual(replacement);
  const pending = await files.readQueued('workspace');
  expect(pending).toEqual(queued(canonical)); expect(pending[0].sources[0]).toEqual(replacement.jobs[0].sources[0]);
  expect(await files.readProgress('workspace')).toEqual(ownerProgress(canonical));
  expect(validate).toHaveBeenCalledTimes(1); expect(cache).toHaveBeenCalledTimes(1);
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(raw);
});

it('never publishes or serves a warm valid packet after a malformed pooled source is durably written', async () => {
  const validate = vi.spyOn(workspaceCodec, 'checkedJevWorkspaceValueReader');
  const cache = vi.spyOn(WorkspacePacketCache.prototype, 'set');
  const valid = demandHistory(); await files.write('workspace', valid); await files.readProgress('workspace');
  const original = await readFile(files.file('workspace'), 'utf8');
  validate.mockClear(); cache.mockClear();
  const malformed = demandHistory(); const nativeSource = malformed.jobs[0].sources[0];
  const pending = files.write('workspace', malformed); nativeSource.metadataRevision = -1;
  await pending;
  const raw = await readFile(files.file('workspace'), 'utf8');
  expect(raw).not.toBe(original); expect(JSON.parse(raw).sources).toContainEqual(expect.objectContaining({ metadataRevision: -1 }));
  expect(validate).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
  await expect(new JevWorkspaceFiles(root).read('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readQueued('workspace')).rejects.toMatchObject({ status: 503 });
  await expect(files.readProgress('workspace')).rejects.toMatchObject({ status: 503 });
  expect(validate).toHaveBeenCalledTimes(2); expect(cache).not.toHaveBeenCalled();
  expect(await readFile(files.file('workspace'), 'utf8')).toBe(raw);
});
