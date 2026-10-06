import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { JevMutation, JevPrincipal, JevProposal } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { approveJevGroup } from './group-approval.js';
import { createHash } from 'node:crypto';
import { JevWorkspaceFiles } from './workspace.js';
import { atomicJson } from '../storage-files.js';
import type { StoredCanvas } from '../storage-shapes.js';
import { evaluateJevAction } from './actions.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const groupKey = 'custom:product/delivery';
let provider: Server;
let providerUrl: string;
let directory: string;
let store: CanvasStore;
let runtime: JevRuntime;
let workspaceId: string;
let canvasId: string;
let documents: string[];
let seedId: string;

function answer(question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.99 };
  if (question.type === 'score') return { type: 'score', score: 0, confidence: 1,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 0 ? 1 : 0])) };
  const criteria = question.criteria; const keys = Object.keys(criteria);
  const selected = keys.find(key => criteria[key].includes(`(${groupKey})`))
    ?? keys.find(key => criteria[key].startsWith('Product Delivery is the Product subgroup'))
    ?? keys.find(key => !['none', 'unknown'].includes(key))!;
  return { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}

beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += String(chunk);
    const body = JSON.parse(data) as { questions: Record<string, JevQuestion> };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(question)])) }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Provider address missing');
  providerUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve())); });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-group-'));
  store = new CanvasStore(directory); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Groups' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Delivery' })).id;
  const seed = await store.createBlock(canvasId, { title: 'Delivery guidance', content: '# Delivery\nProduct delivery plans belong here.' });
  seedId = seed.id;
  await store.updateBlock(canvasId, seed.id, { group: groupKey });
  documents = [];
  for (const title of ['Rollout plan', 'Delivery checklist']) documents.push((await store.createBlock(canvasId, { title,
    content: `# ${title}\nProduct delivery plan and rollout checklist.` })).id);
  runtime = new JevRuntime(store, { startTimer: false,
    evaluate: (context, request) => evaluateJevAction({ ...context, apiKey: 'native-key' }, request),
    fetcher: (_url, options) => fetch(providerUrl, options) });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  await runtime.idle();
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(directory, { recursive: true, force: true }); });

async function proposals(): Promise<JevProposal[]> {
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: documents }, owner); await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed' });
  const pending = state.proposals.filter(item => item.jobId === job.id && item.mutation.kind === 'document');
  expect(pending).toHaveLength(2); return pending;
}

function progressFile(input: { groupKey: string; proposalIds: string[] }): string {
  const digest = createHash('sha256').update(JSON.stringify([workspaceId, input.groupKey, [...input.proposalIds].sort()])).digest('hex');
  return path.join(directory, 'jev', 'workspaces', workspaceId, 'group-approvals', `${digest}.json`);
}

async function appendProposal(base: JevProposal, mutation: JevMutation): Promise<JevProposal> {
  const files = new JevWorkspaceFiles(directory); const state = await files.read(workspaceId);
  const added = { ...structuredClone(base), id: `extra_${state.proposals.length}`, mutation };
  state.proposals.push(added); await files.write(workspaceId, state); return added;
}

it('refuses fabricated approval progress before touching any document', async () => {
  const pending = await proposals(); const input = { groupKey, proposalIds: pending.map(item => item.id).sort() };
  const file = progressFile(input);
  await atomicJson(file, { ...input, approvedProposalIds: [input.proposalIds[0]], state: 'running' }, 0o600);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual([]);
  expect((await store.getCanvasBlock(canvasId, documents[0])).group).toBeUndefined();
});

it('approves all memberships in one selected nested group, persists exact receipts, and remains idempotent after reload', async () => {
  const pending = await proposals(); const input = { groupKey, proposalIds: pending.map(item => item.id) };
  const before = await store.getCanvas(canvasId, true);
  const approved = await approveJevGroup(store, runtime, workspaceId, input, owner);
  expect(approved.approvedProposalIds.sort()).toEqual(input.proposalIds.sort()); expect(approved.receipts).toHaveLength(2);
  const reloaded = await new CanvasStore(directory).getCanvas(canvasId, true);
  for (const id of documents) {
    const block = reloaded.blocks.find(item => item.id === id)!; const original = before.blocks.find(item => item.id === id)!;
    expect(block.group).toBe(groupKey); expect(block.content).toBe(original.content); expect(block.x).toBe(original.x); expect(block.y).toBe(original.y);
  }
  expect(await approveJevGroup(store, runtime, workspaceId, input, owner)).toEqual(approved);
  expect(approved.receipts.every(receipt => !Object.hasOwn(receipt, 'preparedArtifacts'))).toBe(true);
  const digest = createHash('sha256').update(JSON.stringify([workspaceId, groupKey, [...input.proposalIds].sort()])).digest('hex');
  const file = path.join(directory, 'jev', 'workspaces', workspaceId, 'group-approvals', `${digest}.json`);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ state: 'completed', approvedProposalIds: input.proposalIds });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('checks every selected source before applying the first membership and preserves a later human edit', async () => {
  const pending = await proposals();
  await store.updateBlock(canvasId, documents[1], { content: '# Human correction\nKeep this source under review.' });
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: pending.map(item => item.id) }, owner)).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, documents[0])).group).toBeUndefined();
  expect((await store.getCanvasBlock(canvasId, documents[1])).content).toContain('Human correction');
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual([]);
});

it('rejects wrong groups, unrelated proposals, duplicates, pause, and unauthorized reviewers before writes', async () => {
  const pending = await proposals(); const input = { groupKey, proposalIds: pending.map(item => item.id) };
  await expect(approveJevGroup(store, runtime, workspaceId, input, { ...owner, canApprove: false })).rejects.toMatchObject({ status: 403 });
  await expect(approveJevGroup(store, runtime, workspaceId, { ...input, groupKey: 'custom:other' }, owner)).rejects.toMatchObject({ status: 400 });
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: ['missing'] }, owner)).rejects.toMatchObject({ status: 404 });
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [pending[0].id, pending[0].id] }, owner)).rejects.toMatchObject({ status: 400 });
  for (const invalid of [{ groupKey: 'human label', proposalIds: input.proposalIds }, { groupKey, proposalIds: [] },
    { groupKey, proposalIds: [''] }, { groupKey, proposalIds: Array.from({ length: 101 }, (_, index) => String(index)) }]) {
    await expect(approveJevGroup(store, runtime, workspaceId, invalid, owner)).rejects.toMatchObject({ status: 400 });
  }
  const unrelated = await appendProposal(pending[0], { kind: 'document', canvasId, blockId: documents[0], patch: { tags: ['Delivery'] } });
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [unrelated.id] }, owner)).rejects.toMatchObject({ status: 400 });
  await runtime.configure(workspaceId, { paused: true }, owner);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, documents[0])).group).toBeUndefined();
});

async function bootstrapProposals(): Promise<JevProposal[]> {
  await store.deleteBlock(canvasId, seedId);
  for (const [index, id] of documents.entries()) await store.updateBlock(canvasId, id, {
    content: '# Product\n## Delivery\nProduct Delivery is the Product subgroup responsible for release rollout and delivery checklists.\n'
      + (index === 0 ? 'This rollout plan schedules the Product Delivery release and launch handoff.'
        : 'This delivery checklist verifies the Product Delivery release and launch handoff.'),
  });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: documents }, owner); await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)?.state).toBe('completed');
  return state.proposals.filter(item => item.jobId === job.id);
}

it('approves native bootstrap parents before subgroups before individually guarded document memberships', async () => {
  const pending = await bootstrapProposals(); expect(pending).toHaveLength(4);
  expect(pending.filter(item => item.mutation.kind === 'document').every(item => item.sources.length === 1)).toBe(true);
  expect(pending.filter(item => item.mutation.kind === 'document').every(item => item.evidence.some(passage =>
    passage.quote.startsWith('Product Delivery is the Product subgroup') && passage.source.blockId === item.sources[0].blockId))).toBe(true);
  expect(pending.filter(item => item.mutation.kind === 'vocabulary').every(item =>
    documents.every(id => item.sources.some(source => source.blockId === id)))).toBe(true);
  const input = { groupKey, proposalIds: pending.map(item => item.id).reverse() };
  const result = await approveJevGroup(store, runtime, workspaceId, input, owner);
  expect(result.receipts.map(receipt => receipt.after.kind)).toEqual(['vocabulary', 'vocabulary', 'document', 'document']);
  const state = await new JevWorkspaceFiles(directory).read(workspaceId);
  expect(state.vocabulary.map(term => term.groupKey)).toEqual(['custom:product', groupKey]);
  expect(state.vocabulary[1].parentId).toBe(state.vocabulary[0].id);
  expect((await new CanvasStore(directory).getCanvas(canvasId, true)).blocks.every(block => block.group === groupKey)).toBe(true);
  const resumed = await approveJevGroup(store, runtime, workspaceId, input, owner);
  expect(resumed).toEqual(result); expect((await runtime.read(workspaceId, owner)).receipts).toHaveLength(4);
});

it('rejects competing memberships, mixed fields, tasks, candidate definitions, labels and removals', async () => {
  const pending = await proposals(); const base = pending[0];
  const duplicate = await appendProposal(base, base.mutation);
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [base.id, duplicate.id] }, owner)).rejects.toMatchObject({ status: 409 });
  const term = { id: 'fixture_group', name: 'Delivery', kind: 'group' as const, state: 'active' as const,
    groupKey, definition: base.evidence[0].quote, version: 1, aliases: [], members: [{ canvasId, blockId: documents[0] }] };
  const unrelated: JevMutation[] = [
    { kind: 'document', canvasId, blockId: documents[0], patch: { group: groupKey, tags: ['Delivery'] } },
    { kind: 'task_create', canvasId, task: { title: 'Review delivery plan', detail: base.evidence[0].quote, blockIds: [documents[0]], status: 'todo' } },
    { kind: 'vocabulary', operation: 'nominate', term: { ...term, state: 'candidate' } },
    { kind: 'vocabulary', operation: 'define', term: { ...term, kind: 'label', groupKey: undefined } },
    { kind: 'vocabulary', operation: 'remove', term },
    { kind: 'vocabulary', operation: 'define', term: { ...term, state: 'retired' } },
    { kind: 'vocabulary', operation: 'define', term: { ...term, groupKey: 'custom:unrelated' } },
  ];
  for (const mutation of unrelated) {
    const added = await appendProposal(base, mutation);
    await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [added.id] }, owner)).rejects.toMatchObject({ status: 400 });
  }
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [base.id] }, { ...owner, allowedCanvasIds: [] })).rejects.toMatchObject({ status: 404 });
  await expect(approveJevGroup(store, runtime, workspaceId, { groupKey, proposalIds: [base.id] }, { ...owner, tools: ['jev_state'] })).rejects.toMatchObject({ status: 403 });
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual([]);
});

it('does not treat an undone or mismatched receipt as a completed group approval', async () => {
  const pending = await proposals(); const first = pending[0]; const input = { groupKey, proposalIds: [first.id] };
  const receipt = await runtime.apply(workspaceId, first.id, owner);
  const files = new JevWorkspaceFiles(directory); const saved = await files.read(workspaceId);
  const mismatched = structuredClone(saved); mismatched.receipts[0].after = pending[1].mutation;
  await files.write(workspaceId, mismatched);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
  const wrongId = structuredClone(saved); wrongId.proposals.find(item => item.id === first.id)!.receiptId = 'other_receipt';
  await files.write(workspaceId, wrongId);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
  const pendingAgain = structuredClone(saved); pendingAgain.proposals.find(item => item.id === first.id)!.state = 'pending';
  await files.write(workspaceId, pendingAgain);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
  await files.write(workspaceId, saved); await runtime.undo(workspaceId, receipt.id, owner);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('undone') });
  expect((await store.getCanvasBlock(canvasId, documents[0])).group).toBeUndefined();
});

it('rejects malformed, mismatched, invented and incomplete saved progress without canonical writes', async () => {
  const pending = await proposals(); const input = { groupKey, proposalIds: pending.map(item => item.id).sort() };
  const file = progressFile(input); const progress = { ...input, approvedProposalIds: [], state: 'running' };
  const corrupt = [null, {}, { ...progress, extra: true }, { ...progress, state: 'unknown' },
    { ...progress, groupKey: 'custom:other' }, { ...progress, proposalIds: [...input.proposalIds].reverse() },
    { ...progress, approvedProposalIds: ['invented'] }, { ...progress, approvedProposalIds: [input.proposalIds[0], input.proposalIds[0]] },
    { ...progress, state: 'completed' }];
  for (const value of corrupt) {
    await atomicJson(file, value, 0o600);
    await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(value);
  }
  await writeFile(file, '{ broken');
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503 });
  await rm(file); await mkdir(file);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ code: 'EISDIR' });
  expect((await runtime.read(workspaceId, owner)).receipts).toEqual([]);
});

it('recovers a native canonical write failure and resumes durable progress without duplicate receipts', async () => {
  const pending = (await proposals()).sort((left, right) => left.id.localeCompare(right.id));
  const input = { groupKey, proposalIds: pending.map(item => item.id) };
  const canvasesDirectory = path.join(directory, 'canvases');
  await chmod(canvasesDirectory, 0o500);
  try {
    await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 503,
      message: '0 of 2 group changes are saved. Group approval requires recovery' });
  } finally { await chmod(canvasesDirectory, 0o755); }
  expect(JSON.parse(await readFile(progressFile(input), 'utf8'))).toMatchObject({ state: 'failed', approvedProposalIds: [] });
  const result = await approveJevGroup(store, runtime, workspaceId, input, owner);
  expect(result.receipts).toHaveLength(2);
  expect((await runtime.read(workspaceId, owner)).prepared).toEqual([]);
  expect((await runtime.read(workspaceId, owner)).receipts).toHaveLength(2);
  expect(JSON.parse(await readFile(progressFile(input), 'utf8'))).toMatchObject({ state: 'completed', approvedProposalIds: input.proposalIds });
});

it('reports exact partial progress on invalid saved metadata and preserves the first membership during retry', async () => {
  const pending = (await proposals()).sort((left, right) => left.id.localeCompare(right.id));
  const input = { groupKey, proposalIds: pending.map(item => item.id) };
  const second = pending[1].mutation as Extract<JevMutation, { kind: 'document' }>;
  const file = path.join(directory, 'canvases', `${canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  const corrupted = canvas.blocks.find(block => block.id === second.blockId)!;
  corrupted.links = [seedId]; corrupted.linkTypes = { [seedId]: 'invalid_relation' } as never;
  await atomicJson(file, canvas);
  await expect(approveJevGroup(store, runtime, workspaceId, input, owner)).rejects.toMatchObject({ status: 400,
    message: expect.stringContaining('1 of 2 group changes are saved') });
  expect(JSON.parse(await readFile(progressFile(input), 'utf8'))).toMatchObject({ state: 'failed', approvedProposalIds: [pending[0].id],
    error: 'linkTypes must name saved links and supported relations' });
  const repaired = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  const block = repaired.blocks.find(item => item.id === second.blockId)!; block.links = []; delete block.linkTypes;
  await atomicJson(file, repaired);
  const result = await approveJevGroup(store, runtime, workspaceId, input, owner);
  expect(result.receipts).toHaveLength(2); expect((await runtime.read(workspaceId, owner)).receipts).toHaveLength(2);
  expect((await store.getCanvas(canvasId, true)).blocks.filter(item => documents.includes(item.id)).every(item => item.group === groupKey)).toBe(true);
});
