import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JevJson, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { atomicJson } from '../storage-files.js';
import { automationPrincipal } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';
import type { StoredJevReceipt } from './proposals.js';
import { encodeJevWorkspace } from './workspace-codec.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

let root: string; let files: JevWorkspaceFiles;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-packet-miss-')); files = new JevWorkspaceFiles(root); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'current', incarnation: 'original',
  sourceGeneration: 1, metadataRevision: 0, contentHash: 'current-source' };
const historical = { ...source, blockId: 'historical', contentHash: 'history-only-source' };
function job(id: string): StoredJevJob {
  return { id, request: { action: 'profile', canvasId: 'canvas', blockIds: ['current'] }, state: 'queued',
    createdAt: '2026-10-04', updatedAt: '2026-10-04', sources: [source], proposalIds: [],
    principal: automationPrincipal, authorizationFingerprint: 'automatic', settingsKey: 'settings', attempts: 0 };
}
function historyState(): JevWorkspaceState {
  const state = emptyJevWorkspace(); state.jobs = [job('current'), ...Array.from({ length: 64 }, (_, index) =>
    ({ ...job(`history-${index}`), state: 'completed' as const, sources: [historical], contextSources: [historical] }))];
  state.profiles['canvas:current'] = { role: 'reference', keyPassages: ['Current visible excerpt'], scopedSources: [historical] as unknown as JevJson };
  const mutation = { kind: 'derived' as const, blockId: 'historical', values: { scopedSources: [historical] as unknown as JevJson } };
  const canvas = { id: 'canvas', name: 'Historical proof', workspaceId: 'workspace',
    blocks: [{ id: 'historical', title: 'Historical source', kind: 'markdown' as const, file: 'docs/historical.md',
      x: 0, y: 0, width: 400, height: 300, links: [], proofOnly: 'history-only-native-block', tags: ['Exact native metadata'] }] };
  const receipt: StoredJevReceipt = { id: 'historical-receipt', proposalId: 'historical-proposal', action: 'profile',
    createdAt: '2026-10-04', actor: 'automatic', state: 'applied', before: mutation, after: mutation, sourcesAfter: [historical],
    preparedArtifacts: [{ kind: 'canvas', id: 'canvas', before: canvas, after: canvas }] };
  state.receipts = [receipt];
  return state;
}
async function replace(value: unknown) {
  const file = files.file('workspace'); await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, value, 0o600, 0);
  return readFile(file, 'utf8');
}
function observeHistory(raw: string) {
  const parse = JSON.parse; const stringify = JSON.stringify;
  const counts = { hiddenSourceReads: 0, proofSerializations: 0 };
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const value = parse(text, reviver);
    if (text === raw) for (const snapshot of value.sources as JevSourceSnapshot[]) {
      if (snapshot.contentHash !== historical.contentHash) continue;
      Object.defineProperty(snapshot, 'contentHash', { enumerable: true, configurable: true,
        get: () => { counts.hiddenSourceReads += 1; return historical.contentHash; } });
    }
    return value;
  });
  vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, spacing) => {
    if (value?.proofOnly === 'history-only-native-block') counts.proofSerializations += 1;
    return stringify(value, replacer as never, spacing);
  });
  return counts;
}

it.each(['progress', 'queue'] as const)('projects a genuine %s cache miss without restoring discarded historical source vectors or serializing native proof blocks', async kind => {
  const state = historyState(); const raw = await replace(encodeJevWorkspace(state));
  const counts = observeHistory(raw);
  if (kind === 'progress') expect((await files.readProgress('workspace'))!.profiles['canvas:current'].role).toBe('reference');
  else expect((await files.readQueued('workspace')).map(item => item.id)).toEqual(['current']);
  expect(counts).toEqual({ hiddenSourceReads: 1, proofSerializations: 0 });
  vi.restoreAllMocks();
  const canonical = await files.read('workspace');
  expect(canonical.jobs[1].sources).toEqual([historical]);
  expect((canonical.receipts[0] as StoredJevReceipt).preparedArtifacts![0].before).toEqual(
    (state.receipts[0] as StoredJevReceipt).preparedArtifacts![0].before);
});

it.each(['JSON', 'pool', 'artifact', 'shape', 'settings', 'vocabulary'] as const)
('keeps the canonical %s recovery message and validation precedence on an uncached direct projection', async failure => {
  const state = historyState(); const encoded = encodeJevWorkspace(state) as Record<string, unknown>;
  const inner = encoded.state as JevWorkspaceState;
  const messages = { JSON: 'Symbi Reflex workspace state requires recovery', pool: 'Symbi Reflex workspace state requires recovery',
    artifact: 'Symbi Reflex workspace state requires recovery', shape: 'Symbi Reflex workspace state requires recovery',
    settings: 'Symbi Reflex processing settings require recovery', vocabulary: 'Symbi Reflex vocabulary requires recovery' };
  if (failure === 'pool') encoded.vectors = [[999]];
  if (failure === 'artifact') (encoded.blockReferences as Array<{ path: string[] }>)[0].path = ['unsupported'];
  if (failure === 'shape') inner.suppressions = 'Invalid original array' as never;
  if (['shape', 'settings'].includes(failure)) inner.settings.people = [{ id: '', name: 'Invalid', role: '' }];
  if (['shape', 'settings', 'vocabulary'].includes(failure)) inner.vocabulary = [{ id: 'invalid' }] as never;
  await replace(encoded);
  if (failure === 'JSON') await writeFile(files.file('workspace'), '{broken');
  for (const read of [() => files.read('workspace'), () => files.readProgress('workspace'), () => files.readQueued('workspace')]) {
    await expect(read()).rejects.toMatchObject({ status: 503, message: messages[failure] });
  }
});

it('preserves legacy extensions for the canonical fallback and migrates retired queued actions on a fresh miss', async () => {
  const state = historyState();
  Object.assign(state, { codec: 'jev-source-vectors', state: { futureLiteral: true }, futureNotes: { exact: 'Unknown native state' } });
  state.jobs.push({ ...job('retired'), request: { action: 'set_headline', canvasId: 'canvas', blockIds: ['current'] } });
  delete state.settings.automaticPolicyVersion; state.settings.paused = true; state.settings.externalProcessing = false;
  await replace(state);
  expect(await files.readProgress('workspace')).toBeUndefined();
  expect((await files.readQueued('workspace')).map(item => item.id)).toEqual(['current']);
  const canonical = await files.read('workspace');
  expect(canonical).toMatchObject({ codec: 'jev-source-vectors', state: { futureLiteral: true }, futureNotes: { exact: 'Unknown native state' } });
  expect(canonical.settings).toMatchObject({ paused: true, externalProcessing: false });
  expect(canonical.jobs.find(item => item.id === 'retired')!.state).toBe('cancelled');
});
