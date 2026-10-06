import { expect, it } from 'vitest';
import type { JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';
import { checkedJevWorkspaceValueReader, encodeJevWorkspace } from './workspace-codec.js';
import type { WorkspaceDerivedValuePool } from './workspace-derived-value-pool.js';
import { workspaceReadPacket } from './workspace-read-packet.js';
import { emptyJevWorkspace } from './workspace.js';

const quote = 'Exact retained source responsibility remains independently owned after projection. '.repeat(3);
const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'source',
  incarnation: 'original', sourceGeneration: 1, metadataRevision: 2, contentHash: 'checked-content' };
type Envelope = WorkspaceDerivedValuePool & { state: JevWorkspaceState; version: number };

function envelope(): Envelope {
  const state = emptyJevWorkspace();
  state.profiles = { 'canvas:source': { role: 'reference', keyPassages: [quote] },
    'canvas:other': { role: 'reference', keyPassages: [quote] } };
  state.jobs = [{ id: 'queued', request: { action: 'profile', canvasId: 'canvas', blockIds: ['source'] },
    state: 'queued', createdAt: '2026-10-05', updatedAt: '2026-10-05', sources: [source], proposalIds: [],
    principal: automationPrincipal, authorizationFingerprint: 'automatic', settingsKey: 'policy', attempts: 0 } as StoredJevJob];
  const encoded = JSON.parse(JSON.stringify(encodeJevWorkspace(state))) as Envelope;
  expect(encoded.version).toBe(3);
  return encoded;
}
function validate(state: JevWorkspaceState): void {
  expect(state.schemaVersion).toBe(1);
  expect(state.settings.externalProcessing).toBe(true);
  expect(state.profiles['canvas:source'].keyPassages).toEqual([quote]);
}

it('uses an operation-local checked reader without revalidating its derived dictionary', () => {
  const encoded = envelope(); const passages = encoded.derivedValues[0] as string[];
  let reads = 0;
  Object.defineProperty(passages, '0', { enumerable: true, configurable: true, get: () => { reads++; return quote; } });
  const read = checkedJevWorkspaceValueReader(encoded);
  expect(reads).toBe(1);
  const packet = workspaceReadPacket(encoded, validate, read);
  expect(packet.progress?.profiles['canvas:other'].keyPassages).toEqual([quote]);
  expect(packet.queuedJobs[0].sources).toEqual([source]);
  expect(reads).toBe(1);
});

it.each([false, true])('returns independent public projections with a supplied checked reader=%s', supplied => {
  const encoded = envelope(); const read = supplied ? checkedJevWorkspaceValueReader(encoded) : undefined;
  const first = workspaceReadPacket(encoded, validate, read);
  const original = JSON.stringify(encoded);
  (first.progress!.profiles['canvas:source'].keyPassages as string[])[0] = 'Caller-only change';
  first.queuedJobs[0].sources[0].incarnation = 'Caller-only source';
  first.queuedJobs[0].request.blockIds!.push('Caller-only scope');
  const second = workspaceReadPacket(encoded, validate, read);
  expect(second.progress!.profiles['canvas:source'].keyPassages).toEqual([quote]);
  expect(second.progress!.profiles['canvas:other'].keyPassages).toEqual([quote]);
  expect(second.queuedJobs[0].sources).toEqual([source]);
  expect(second.queuedJobs[0].request.blockIds).toEqual(['source']);
  expect(JSON.stringify(encoded)).toBe(original);
});

it('keeps ordinary live profiles available to direct legacy callers without a prepared reader', () => {
  const state = emptyJevWorkspace();
  state.profiles['canvas:source'] = { role: 'reference', keyPassages: [quote, 'Second exact passage'] };
  const first = workspaceReadPacket(state, validate);
  expect(first.queuedJobs).toEqual([]);
  expect(first.progress?.profiles['canvas:source']).toEqual({ role: 'reference', keyPassages: [quote] });
  (first.progress!.profiles['canvas:source'].keyPassages as string[])[0] = 'Caller-only legacy change';
  expect(workspaceReadPacket(state, validate).progress?.profiles['canvas:source'].keyPassages).toEqual([quote]);
  expect(state.profiles['canvas:source'].keyPassages).toEqual([quote, 'Second exact passage']);
});

it.each([
  ['unused invalid dictionary value', (encoded: Envelope) => { encoded.derivedValues.push({ unsupported: undefined }); }],
  ['duplicate reference', (encoded: Envelope) => { encoded.derivedValueReferences.push(encoded.derivedValueReferences[0]); }],
  ['dangling reference', (encoded: Envelope) => { encoded.derivedValueReferences[0].value = 999; }],
  ['unsupported slot', (encoded: Envelope) => { encoded.derivedValueReferences[0].path = ['profiles', 'canvas:source', 'scopedSources']; }],
  ['non-placeholder slot', (encoded: Envelope) => { encoded.state.profiles['canvas:source'].keyPassages = [quote]; }],
] as const)('keeps strict derived validation for direct callers without a prepared reader (%s)', (_description, corrupt) => {
  const encoded = envelope(); corrupt(encoded);
  expect(() => workspaceReadPacket(encoded, validate)).toThrowError(expect.objectContaining({
    status: 503, message: 'Symbi Reflex workspace state requires recovery',
  }));
});

it('still runs projection validation before exposing a packet with a supplied reader', () => {
  const encoded = envelope(); const read = checkedJevWorkspaceValueReader(encoded);
  expect(() => workspaceReadPacket(encoded, state => {
    validate(state); throw new Error('Projection rejected');
  }, read)).toThrow('Projection rejected');
});
