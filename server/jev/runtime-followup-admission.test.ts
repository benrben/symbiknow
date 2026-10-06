import { expect, it } from 'vitest';
import type { JevActionRequest, JevPrincipal, JevSourceSnapshot } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import { emptyJevWorkspace } from './workspace.js';
import { applyJevFollowupAdmission, checkJevFollowupAdmission, matchesJevFollowupAdmission,
  type JevChainedJob, type JevFollowupAdmission } from './runtime-followup-admission.js';

const source: JevSourceSnapshot = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'document', incarnation: 'original',
  sourceGeneration: 1, contentHash: 'hash', metadataRevision: 0 };
const admission: JevFollowupAdmission = { key: 'checked-chain', remaining: ['link'] };
const request: JevActionRequest = { action: 'label', canvasId: 'canvas', blockIds: ['document'], idempotencyKey: 'checked-chain:label' };
function job(): JevChainedJob {
  return { id: 'checked-job', request: structuredClone(request), state: 'queued', createdAt: '2026-10-04', updatedAt: '2026-10-04',
    sources: [structuredClone(source)], proposalIds: [] };
}

it('leaves ordinary admission unchanged and accepts only the exact automatic grant for an internal chain', () => {
  expect(() => checkJevFollowupAdmission(request, { id: 'owner', kind: 'user', access: 'write' })).not.toThrow();
  expect(() => checkJevFollowupAdmission(request, automationPrincipal, admission)).not.toThrow();
});

it.each([
  { id: 'owner', kind: 'user', access: 'write' }, { ...automationPrincipal, kind: 'user' },
  { ...automationPrincipal, access: 'read' }, { ...automationPrincipal, allowedCanvasIds: ['canvas'] },
  { ...automationPrincipal, tools: ['jev_do'] },
] as JevPrincipal[])('rejects a modified or manual internal grant %j', principal => {
  expect(() => checkJevFollowupAdmission(request, principal, admission)).toThrow(expect.objectContaining({ status: 403 }));
});

it.each([
  { key: 4, remaining: [] }, { key: '', remaining: [] }, { key: 'checked-chain', remaining: null },
  { key: 'checked-chain', remaining: ['set_headline'] }, { key: 'unbound-chain', remaining: [] },
] as unknown as JevFollowupAdmission[])('rejects invalid private admission %j', value => {
  expect(() => checkJevFollowupAdmission(request, automationPrincipal, value)).toThrow(expect.objectContaining({ status: 400 }));
});

it('binds each request action and its operation key to the private chain key', () => {
  expect(() => checkJevFollowupAdmission({ ...request, idempotencyKey: undefined }, automationPrincipal, admission))
    .toThrow(expect.objectContaining({ status: 400 }));
  expect(() => checkJevFollowupAdmission({ ...request, action: 'link' }, automationPrincipal, admission))
    .toThrow(expect.objectContaining({ status: 400 }));
});

it('clones fresh checked sources and remaining actions without sharing caller-owned mutable arrays', () => {
  const current = job(); const input = structuredClone(admission); const state = emptyJevWorkspace();
  expect(applyJevFollowupAdmission(state, current)).toBe(false);
  expect(applyJevFollowupAdmission(state, current, input)).toBe(true);
  expect(matchesJevFollowupAdmission(current, admission)).toBe(true);
  expect(applyJevFollowupAdmission(state, current, admission)).toBe(false);
  input.remaining.push('link'); current.sources[0].metadataRevision = 8;
  expect(current.followupActions).toEqual(['link']);
  expect(current.followupSources).toEqual([source]);
});

it('carries the original chain vector across steps while keeping each fresh source vector independent', () => {
  const original = { ...job(), followupKey: admission.key, followupSources: [{ ...source, metadataRevision: 3 }] };
  const unrelated: JevChainedJob = { ...job(), followupKey: 'unrelated' };
  const state = emptyJevWorkspace(); state.jobs = [unrelated, original];
  const next = job(); next.sources[0].metadataRevision = 9;
  expect(applyJevFollowupAdmission(state, next, admission)).toBe(true);
  expect(next.followupSources).toEqual([{ ...source, metadataRevision: 3 }]);
  next.followupSources![0].metadataRevision = 12;
  expect(original.followupSources[0].metadataRevision).toBe(3);
  expect(next.sources[0].metadataRevision).toBe(9);
});

it('repairs missing legacy original sources from the newly checked job and rejects incomplete fast-path fields', () => {
  const legacy: JevChainedJob = { ...job(), followupKey: admission.key };
  const state = emptyJevWorkspace(); state.jobs = [legacy];
  const current: JevChainedJob = { ...job(), followupKey: admission.key, followupActions: ['link'] };
  expect(matchesJevFollowupAdmission(current, admission)).toBe(false);
  current.followupActions = ['link'];
  expect(matchesJevFollowupAdmission(current, admission)).toBe(false);
  expect(applyJevFollowupAdmission(state, current, admission)).toBe(true);
  expect(current.followupSources).toEqual([source]);
  expect(matchesJevFollowupAdmission({ ...current, followupKey: 'other' }, admission)).toBe(false);
});
