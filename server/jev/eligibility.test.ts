import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CanvasStore } from '../storage.js';
import type { JevProposal, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import type { JevEvaluationContext } from './actions/context.js';
import { JevWorkspaceFiles } from './workspace.js';
import { sourceSnapshot } from './stamps.js';
import { automaticHoldReason, eligibleAutomatic } from './eligibility.js';

let root: string;
let store: CanvasStore;
let state: JevWorkspaceState;
let context: JevEvaluationContext;
let proposal: JevProposal;
let group: JevVocabularyTerm;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reflex-eligibility-'));
  store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Eligibility' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const block = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nAtlas delivery purpose.' });
  const snapshot = sourceSnapshot(workspace.id, canvas.id, block);
  state = await new JevWorkspaceFiles(root).read(workspace.id);
  state.settings.externalProcessing = true;
  for (const action of Object.keys(state.settings.modes) as Array<keyof typeof state.settings.modes>) state.settings.modes[action] = 'auto';
  context = { workspaceId: workspace.id, documents: [{ canvasId: canvas.id, block, snapshot }], canvases: [canvas],
    tasks: [], vocabulary: [], settings: state.settings };
  group = { id: 'atlas', kind: 'group', name: 'Atlas', definition: 'Atlas delivery', aliases: [], state: 'active', version: 1,
    groupKey: 'custom:atlas', members: [{ canvasId: canvas.id, blockId: block.id }] };
  proposal = { id: 'proposal', jobId: 'job', action: 'file', title: 'File Atlas', explanation: 'Supported purpose', confidence: 0.99,
    sources: [snapshot], evidence: [{ source: snapshot, start: 0, end: 7, quote: '# Atlas' }],
    mutation: { kind: 'document', canvasId: canvas.id, blockId: block.id, patch: { group: 'custom:atlas' } },
    state: 'pending', createdAt: new Date().toISOString() };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('checks every semantic certificate against the configured automatic threshold', () => {
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  proposal.decisionConfidences = [0.99, 0.8];
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  proposal.decisionConfidences = [0.95, 0.99];
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  proposal.confidence = 0.94999;
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  state.settings.confidenceThresholds = { file: 0.85 };
  proposal.decisionConfidences = [0.95, 0.8];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/85% automatic threshold/);
  state.settings.confidenceThresholds.file = 0.75;
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  delete state.settings.confidenceThresholds;
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
});
it.each([undefined, NaN, Infinity, -0.01, 1.01])('holds missing or invalid scalar certificate %s', value => {
  proposal.confidence = value;
  expect(eligibleAutomatic(state, proposal, context)).toBe(false);
});
it.each([
  ['paused', () => { state.settings.paused = true; }, /paused/],
  ['no consent', () => { state.settings.externalProcessing = false; }, /consent/],
  ['suggest mode', () => { state.settings.modes.file = 'suggest'; }, /configured for review/],
  ['explicit empty allowlist', () => { state.settings.calibratedActions = []; }, /allowlist/],
  ['no evidence', () => { proposal.evidence = []; }, /supporting evidence/],
] as const)('reports a concrete policy hold for %s', (_name, alter, reason) => {
  alter(); expect(automaticHoldReason(state, proposal, context)).toMatch(reason);
});
it('keeps pinned types, removed labels, and removed local or remote connections authoritative', () => {
  const block = context.documents[0].block;
  const ownership = block.jevOwnership!;
  ownership.pins.push('linkTypes');
  proposal.action = 'link';
  proposal.mutation = { kind: 'document', canvasId: context.documents[0].canvasId, blockId: block.id, patch: { links: ['other'] } };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/pinned/);
  ownership.pins = [];
  ownership.removedLinks = ['other'];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/removed connection/);
  proposal.mutation.patch = { crossLinks: [{ canvasId: 'remote', blockId: 'other' }] };
  ownership.removedLinks = ['remote:other'];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/removed connection/);
  proposal.action = 'label'; proposal.mutation.patch = { tags: ['removed'] }; ownership.removedLabels = ['removed'];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/removed label/);
});
it('requires ownership reconciliation and specific exclusions and unsupported mutation paths', () => {
  const mutation = proposal.mutation;
  delete context.documents[0].block.jevOwnership;
  expect(automaticHoldReason(state, proposal, context)).toMatch(/ownership reconciliation/);
  proposal.mutation = { kind: 'document', canvasId: context.documents[0].canvasId, blockId: 'missing', patch: { processingExcluded: true } };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/exclusions/);
  proposal.mutation = { kind: 'derived', values: {} };
  expect(automaticHoldReason(state, proposal, context)).toMatch(/Derived results/);
  proposal.mutation = mutation;
  expect(automaticHoldReason(state, proposal, context)).toMatch(/ownership reconciliation/);
});
it('never admits source edits through a retained action even when a historical staged review is complete', () => {
  const document = context.documents[0];
  proposal.mutation = { kind: 'content', canvasId: document.canvasId, blockId: document.block.id,
    content: '# Updated Atlas', expectedContentHash: document.snapshot.contentHash, draftId: 'draft' };
  context.draft = { id: 'draft', baseContent: document.block.content, proposedContent: '# Updated Atlas', instruction: 'Update Atlas' };
  state.jobs.push({ id: proposal.jobId, request: { action: 'review_agent_edit', canvasId: document.canvasId }, state: 'completed',
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, sources: proposal.sources, proposalIds: [proposal.id],
    result: { ready: true, state: 'ready', coverage: 'complete', findings: [] } });
  expect(automaticHoldReason(state, proposal, context)).toMatch(/source editing has no supported action/);
});
it('orders reviewed bootstrap definitions before membership and requires an active certified group', () => {
  const definition = { ...proposal, id: 'definition', mutation: { kind: 'vocabulary' as const, operation: 'define', term: group } };
  state.proposals.push(definition);
  expect(automaticHoldReason(state, proposal, context)).toMatch(/applied before filing/);
  state.proposals = []; delete proposal.confidence; proposal.decisionConfidences = [0.99, 0.98];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/must be active/);
  state.vocabulary.push(group);
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
});
it('permits only active evidenced group definitions whose parent and every member are supported', () => {
  proposal.mutation = { kind: 'vocabulary', operation: 'define', term: group };
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  group.parentId = 'parent';
  expect(automaticHoldReason(state, proposal, context)).toMatch(/parent/);
  state.vocabulary.push({ ...group, id: 'parent', parentId: undefined, groupKey: 'custom:parent', name: 'Parent' });
  expect(eligibleAutomatic(state, proposal, context)).toBe(true);
  context.documents[0].block.jevOwnership!.pins.push('group');
  expect(automaticHoldReason(state, proposal, context)).toMatch(/member/);
  context.documents[0].block.jevOwnership!.pins = [];
  group.members.push({ canvasId: 'missing', blockId: 'source' });
  expect(automaticHoldReason(state, proposal, context)).toMatch(/member/);
  group.members = [];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/reviewed source members/);
});
it('requires individual member evidence and holds taxonomy changes beyond bootstrap define', () => {
  proposal.mutation = { kind: 'vocabulary', operation: 'define', term: group };
  group.members = [{ canvasId: context.documents[0].canvasId, blockId: context.documents[0].block.id }];
  proposal.evidence = [{ ...proposal.evidence[0], source: { ...proposal.sources[0], blockId: 'other' } }];
  expect(automaticHoldReason(state, proposal, context)).toMatch(/Each group member/);
  proposal.mutation.operation = 'rename';
  expect(automaticHoldReason(state, proposal, context)).toMatch(/supported definition/);
});
