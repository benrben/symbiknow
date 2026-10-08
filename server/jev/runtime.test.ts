import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,readFile,rename,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { JevActionRequest,JevEvaluation,JevPrincipal } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { CanvasStore } from '../storage.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import type { JevEvaluationContext } from './actions/context.js';
import { automationPrincipal } from './authorization.js';
import { stageJevDraft } from './drafts.js';
import { JevRuntime } from './runtime.js';
import { sourceSnapshot } from './stamps.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let directory: string;
let store: CanvasStore;
let runtime: JevRuntime;
let workspaceId: string;
let canvasId: string;

function evaluate(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  if (request.action !== 'file') return Promise.resolve({ result: {}, proposals: [] });
  const document = context.documents.find(item => item.canvasId === request.canvasId && request.blockIds?.includes(item.block.id))!;
  return Promise.resolve({ result: { status: 'proposed' }, proposals: [{ action: request.action,
    title: 'File document', explanation: 'Exact supported group', sources: [document.snapshot], confidence: 0.99,
    evidence: [{ source: document.snapshot, start: 0, end: 5, quote: document.block.content.slice(0, 5) }],
    mutation: { kind: 'document' as const, canvasId, blockId: document.block.id, patch: { group: 'custom:atlas' } } }] });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'symbi-reflex-runtime-'));
  store = new CanvasStore(directory); await store.init(); await store.deleteWorkspace('acme-team');
  workspaceId = (await store.createWorkspace({ name: 'Runtime' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Sources' })).id;
  runtime = new JevRuntime(store, { evaluate, startTimer: false });
  await runtime.configure(workspaceId, { modes: { file: 'auto' } as never }, owner);
});
afterEach(async () => { runtime.close(); await runtime.idle(); await rm(directory, { recursive: true, force: true }); });

async function fileProposal() {
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas rollout' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner);
  await runtime.idle();
  const state = await runtime.read(workspaceId, owner);
  expect(state.jobs.find(item => item.id === job.id)?.state).toBe('completed');
  return { block, proposal: state.proposals.find(item => item.jobId === job.id)! };
}

it('waits quietly for a provider on ordinary saves and preserves the independent source write', async () => {
  const block = await store.createBlock(canvasId, { title: 'Saved normally', content: '# Saved normally' });
  await runtime.idle();
  expect((await runtime.read(workspaceId)).jobs).toEqual([]);
  expect((await store.getCanvasBlock(canvasId, block.id)).content).toBe('# Saved normally');
  expect((await runtime.read(workspaceId)).settings.modes.profile).toBe('auto');
});

it('persists proposals, applies exactly once, and restores absent metadata with checked Undo', async () => {
  const { block, proposal } = await fileProposal();
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
  const receipt = await runtime.apply(workspaceId, proposal.id, owner);
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
  expect((await runtime.apply(workspaceId, proposal.id, owner)).id).toBe(receipt.id);
  const restarted = new JevRuntime(new CanvasStore(directory), { evaluate, startTimer: false });
  try {
    expect((await restarted.read(workspaceId, owner)).receipts).toHaveLength(1);
    await restarted.undo(workspaceId, receipt.id, owner);
    expect((await store.getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
    expect((await restarted.read(workspaceId)).receipts.find(item => item.id === receipt.id)?.state).toBe('undone');
  } finally { restarted.close(); await restarted.idle(); }
});

it('rejects stale sources and a later explicit correction prevents Undo', async () => {
  const { block, proposal } = await fileProposal();
  await store.updateBlock(canvasId, block.id, { content: '# New Atlas requirements' });
  await expect(runtime.apply(workspaceId, proposal.id, owner)).rejects.toMatchObject({ status: 409 });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  const fresh = (await runtime.read(workspaceId)).proposals.find(item => item.jobId === job.id)!;
  const receipt = await runtime.apply(workspaceId, fresh.id, owner);
  await runtime.setMetadata(workspaceId, canvasId, block.id, { group: 'custom:manual' }, owner);
  await expect(runtime.undo(workspaceId, receipt.id, owner)).rejects.toMatchObject({ status: 409 });
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:manual');
});

it('persists removal overrides and pin/manage preferences through reload', async () => {
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas', tags: ['pilot'] });
  await runtime.setMetadata(workspaceId, canvasId, block.id, { tags: [], pins: ['group'], managed: ['tags'] }, owner);
  const read = await new CanvasStore(directory).getCanvasBlock(canvasId, block.id);
  expect(read.jevOwnership).toMatchObject({ pins: ['group'], removedLabels: ['pilot'], managed: ['tags'] });
});

it('recovers a prepared mutation after a real canonical write obstruction without duplicate effects', async () => {
  const { block, proposal } = await fileProposal();
  const file = path.join(directory, 'canvases', `${canvasId}.json`);
  const execute = store.jevExecutor.execute.bind(store.jevExecutor);
  store.jevExecutor.execute = (mutation, sources, id, actor, managed, prepare, restore) => execute(mutation, sources, id, actor, managed, async plan => {
    await prepare(plan); await rename(file, file + '.backup'); await mkdir(file);
  }, restore);
  await expect(runtime.apply(workspaceId, proposal.id, owner)).rejects.toThrow();
  expect((await new JevWorkspaceFiles(directory).read(workspaceId)).prepared).toHaveLength(1);
  await rm(file, { recursive: true }); await rename(file + '.backup', file);
  store.jevExecutor.execute = execute;
  await runtime.reconcile(workspaceId);
  const receipt = await runtime.apply(workspaceId, proposal.id, owner);
  expect(receipt.state).toBe('applied');
  expect((await runtime.read(workspaceId)).prepared).toHaveLength(0);
  expect((await runtime.read(workspaceId)).receipts).toHaveLength(1);
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
});

it('revocation during inference cancels the result and keeps canonical metadata unchanged', async () => {
  const credential = await store.createMcpToken('Scoped reviewer', 'propose', { allowedCanvasIds: [canvasId], tools: ['jev_do'] });
  const token = (await store.mcpTokenIdentity(credential.token))!;
  let resume!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => { began(); await wait; return evaluate(context, request); } });
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, { ...token, kind: 'token' });
  await started; await store.revokeMcpToken(token.id); resume(); await runtime.idle();
  expect((await runtime.read(workspaceId)).jobs.find(item => item.id === job.id)?.state).toBe('failed');
  expect((await runtime.read(workspaceId)).proposals).toHaveLength(0);
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
});

it('validates complete metadata overrides before a write and keeps dismissal distinct from suppression', async () => {
  const { block, proposal } = await fileProposal();
  const before = await store.getCanvasBlock(canvasId, block.id);
  await expect(runtime.setMetadata(workspaceId, canvasId, block.id, { group: 'custom:changed', pins: ['invalid'] }, owner)).rejects.toMatchObject({ status: 400 });
  expect(await store.getCanvasBlock(canvasId, block.id)).toEqual(before);
  await runtime.dismiss(workspaceId, proposal.id, owner);
  expect((await runtime.read(workspaceId)).suppressions).toEqual([]);
  await store.updateBlock(canvasId, block.id, { content: '# Atlas new rollout' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  expect((await runtime.read(workspaceId)).proposals.find(item => item.jobId === job.id)?.state).toBe('pending');
});

it('preserves unrelated explicit metadata corrections and their ownership when undoing a different field', async () => {
  const { block, proposal } = await fileProposal();
  const receipt = await runtime.apply(workspaceId, proposal.id, owner);
  await runtime.setMetadata(workspaceId, canvasId, block.id, { tags: ['manual'] }, owner);
  await runtime.undo(workspaceId, receipt.id, owner);
  const current = await store.getCanvasBlock(canvasId, block.id);
  expect(current.group).toBeUndefined(); expect(current.tags).toEqual(['manual']);
  expect(current.jevOwnership?.pins).toContain('tags');
});

it('compensates unchanged automatic metadata with the parent Undo and retains unrelated later work', async () => {
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { evaluate, apiKey: 'test-provider', startTimer: false });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas original' });
  const other = await store.createBlock(canvasId, { title: 'Separate work', content: '# Separate' });
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, automationPrincipal); await runtime.idle();
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
  await store.updateBlock(canvasId, other.id, { content: '# Later separate work' });
  await runtime.undoParent(workspaceId, canvasId, { kind: 'created', after: block }, owner);
  expect((await store.getCanvas(canvasId, true)).blocks.some(item => item.id === block.id)).toBe(false);
  expect((await store.getCanvasBlock(canvasId, other.id)).content).toBe('# Later separate work');
  expect((await runtime.read(workspaceId)).jobs.some(job => job.sources.some(source => source.blockId === block.id))).toBe(false);
});

it('preflights new references before compensation so rejected parent Undo preserves organization', async () => {
  runtime.close(); await runtime.idle(); runtime = new JevRuntime(store, { evaluate, apiKey: 'test-provider', startTimer: false });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas original' });
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, automationPrincipal); await runtime.idle();
  await store.createBlock(canvasId, { title: 'Later reference', content: '# Reference', links: [block.id] });
  const organized = await store.getCanvasBlock(canvasId, block.id);
  await expect(runtime.undoParent(workspaceId, canvasId, { kind: 'created', after: block }, owner)).rejects.toMatchObject({ status: 409 });
  expect(await store.getCanvasBlock(canvasId, block.id)).toEqual(organized);
});

it('shares canonical write serialization between store instances and returns only public job fields', async () => {
  const second = new CanvasStore(directory);
  const [first, other] = await Promise.all([store.createBlock(canvasId, { title: 'First', content: '# First' }), second.createBlock(canvasId, { title: 'Second', content: '# Second' })]);
  expect((await store.getCanvas(canvasId)).blocks.map(block => block.id)).toEqual(expect.arrayContaining([first.id, other.id]));
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [first.id] }, owner); await runtime.idle();
  expect(Object.keys(job)).not.toContain('principal'); expect(Object.keys(job)).not.toContain('settingsKey');
  expect(job.questionVersion).toBe(JEV_QUESTION_VERSION);
  expect(Object.keys((await runtime.read(workspaceId)).jobs[0])).not.toContain('authorizationFingerprint');
});

it.each(['prepared', 'canonical'])('recovers after the applying process is killed at the %s boundary', async boundary => {
  const { block, proposal } = await fileProposal();
  runtime.close(); await runtime.idle();
  const fixture = path.join(directory, `kill-${boundary}.mjs`);
  const imports = { store: pathToFileURL(path.resolve('server/storage.ts')).href, runtime: pathToFileURL(path.resolve('server/jev/runtime.ts')).href };
  await writeFile(fixture, `import { CanvasStore } from ${JSON.stringify(imports.store)};
import { JevRuntime } from ${JSON.stringify(imports.runtime)};
const store = new CanvasStore(${JSON.stringify(directory)});
const runtime = new JevRuntime(store, {startTimer:false});
const execute = store.jevExecutor.execute.bind(store.jevExecutor);
store.jevExecutor.execute = async (mutation,sources,id,actor,managed,prepare,ownership) => {
  const result = await execute(mutation,sources,id,actor,managed,async plan => {
    await prepare(plan);
    if (${JSON.stringify(boundary)} === 'prepared') process.kill(process.pid,'SIGKILL');
  },ownership);
  process.kill(process.pid,'SIGKILL');
  return result;
};
await runtime.apply(${JSON.stringify(workspaceId)},${JSON.stringify(proposal.id)},${JSON.stringify(owner)});
`);
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = ''; child.stderr.on('data', chunk => { failure += String(chunk); });
  const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  expect(ended.signal, failure).toBe('SIGKILL');
  const persisted = await new JevWorkspaceFiles(directory).read(workspaceId);
  expect(persisted.prepared).toHaveLength(1);
  runtime = new JevRuntime(new CanvasStore(directory), { evaluate, startTimer: false });
  await runtime.idle();
  const state = await runtime.read(workspaceId);
  expect(state.prepared).toHaveLength(0); expect(state.receipts).toHaveLength(1);
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
  await runtime.apply(workspaceId, proposal.id, owner);
  expect((await runtime.read(workspaceId)).receipts).toHaveLength(1);
});

it('rejects corrupt persisted staged drafts with an explicit recovery error', async () => {
  const block = await store.createBlock(canvasId, { title: 'Draft source', content: '# Source' });
  const file = path.join(directory, 'jev', 'drafts', canvasId, `${block.id}.json`);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ id: 'broken', generation: 1, proposedContent: '# Draft', expiresAt: 'not-a-date' }));
  await expect(runtime.hasActiveDraft(canvasId, block.id)).rejects.toMatchObject({ status: 503 });
  await expect(runtime.readDraft(workspaceId, canvasId, block.id, owner)).rejects.toMatchObject({ status: 503 });
});

it('purges deleted canvas analyses and protected drafts while retaining unrelated workspace sources', async () => {
  const { block } = await fileProposal();
  await stageJevDraft(directory, sourceSnapshot(workspaceId, canvasId, block),
    { id: 'held-private', baseContent: block.content, proposedContent: '# Private draft', instruction: 'Edit' }, owner.id);
  const remaining = await store.createCanvas(workspaceId, { name: 'Keep' });
  const keep = await store.createBlock(remaining.id, { title: 'Kept source', content: '# Keep this' });
  await store.deleteCanvas(canvasId); await runtime.idle();
  const state = await runtime.read(workspaceId);
  expect(state.jobs).toEqual([]); expect(state.proposals).toEqual([]); expect(state.receipts).toEqual([]);
  await expect(readFile(path.join(directory, 'jev', 'drafts', canvasId, `${block.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.getCanvasBlock(remaining.id, keep.id)).content).toBe('# Keep this');
});

it('purges the entire deleted workspace journal tree and does not recreate it on restart', async () => {
  await fileProposal();
  await store.deleteWorkspace(workspaceId); await runtime.idle();
  const file = path.join(directory, 'jev', 'workspaces', workspaceId, 'state.json');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  runtime.close(); await runtime.idle(); runtime = new JevRuntime(new CanvasStore(directory), { evaluate, startTimer: false });
  await runtime.idle(); await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps an active inference running during reconciliation from another store instance and unrelated saves', async () => {
  runtime.close(); await runtime.idle();
  let release!: () => void; let began!: () => void; let evaluations = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    evaluations++; began(); await blocked; return evaluate(context, request);
  } });
  const block = await store.createBlock(canvasId, { title: 'Active source', content: '# Active source' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner);
  await started;
  const second = new JevRuntime(new CanvasStore(directory), { evaluate, startTimer: false });
  try {
    await second.idle();
    await store.createBlock(canvasId, { title: 'Independent save', content: '# Independent save' });
    await runtime.reconcile(workspaceId);
    expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('running');
  } finally { release(); second.close(); await second.idle(); }
  await runtime.idle();
  expect(evaluations).toBe(1);
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('completed');
});

it('does not revive a cancelled queued job', async () => {
  runtime.close(); await runtime.idle();
  let release!: () => void; let began!: () => void; let calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    calls++; if (calls === 1) { began(); await blocked; }
    return evaluate(context, request);
  } });
  const first = await store.createBlock(canvasId, { title: 'First', content: '# First' });
  const second = await store.createBlock(canvasId, { title: 'Second', content: '# Second' });
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [first.id] }, owner); await started;
  try {
    const queued = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [second.id] }, owner);
    await runtime.cancel(workspaceId, queued.id, owner);
    await expect(runtime.cancel(workspaceId, 'missing', owner)).rejects.toMatchObject({ status: 404 });
    release(); await runtime.idle();
    expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === queued.id)?.state).toBe('cancelled');
    expect(calls).toBe(1);
  } finally { release(); }
});

it('accepts owner interactive Auto with supported confidence and preserves agent self-approval denial', async () => {
  runtime.close(); await runtime.idle();
  let certainty = 0.8;
  runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-policy-provider', evaluate: async (context, request) => {
    const result = await evaluate(context, request);
    result.proposals[0] = { ...result.proposals[0], decisionConfidences: [0.99, certainty] };
    return result;
  } });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  const block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas owner Auto' });
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
  expect((await runtime.read(workspaceId, owner)).proposals[0].decisionConfidences).toEqual([0.99, 0.8]);
  certainty = 0.99;
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBe('custom:atlas');
  const credential = await store.createMcpToken('Scoped agent', 'propose', { allowedCanvasIds: [canvasId], tools: ['jev_do'] });
  const token = (await store.mcpTokenIdentity(credential.token))!;
  const agentSource = await store.createBlock(canvasId, { title: 'Agent source', content: '# Agent source' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [agentSource.id] }, { ...token, kind: 'token' });
  await runtime.idle();
  const proposal = (await runtime.read(workspaceId, owner)).proposals.find(item => item.jobId === job.id)!;
  expect(proposal.automaticHoldReason).toMatch(/cannot approve/);
  expect((await store.getCanvasBlock(canvasId, agentSource.id)).group).toBeUndefined();
});

it('preserves saved classification and per-edge ownership through ordinary inspector overrides', async () => {
  const first = await store.createBlock(canvasId, { title: 'Reader', content: '# Reader', workArea: 'operations' });
  const target = await store.createBlock(canvasId, { title: 'Target', content: '# Target' });
  await store.updateBlock(canvasId, first.id, { links: [target.id], linkTypes: { [target.id]: 'implements' } }, 'Browser');
  const saved = await store.getCanvasBlock(canvasId, first.id);
  expect(saved.jevOwnership!.pins).toEqual(expect.arrayContaining(['linkTypes', 'workArea']));
  const managed = [...saved.jevOwnership!.managed, `link:${canvasId}:${target.id}`];
  await runtime.setMetadata(workspaceId, canvasId, first.id, { group: 'custom:manual', pins: saved.jevOwnership!.pins, managed }, owner);
  const current = await new CanvasStore(directory).getCanvasBlock(canvasId, first.id);
  expect(current.jevOwnership!.managed).toContain(`link:${canvasId}:${target.id}`);
  expect(current.linkTypes).toEqual({ [target.id]: 'implements' });
  expect(current.workArea).toBe('operations');
});

it('retries a transient provider failure once and exposes an exhausted failure without changing source metadata', async () => {
  runtime.close(); await runtime.idle(); let attempts = 0;
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async (context, request) => {
    attempts++; if (attempts % 2 === 1) throw new ApiError(503, 'Provider temporarily unavailable');
    return evaluate(context, request);
  } });
  const block = await store.createBlock(canvasId, { title: 'Retry', content: '# Retry source' });
  const job = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  expect(attempts).toBe(2);
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === job.id)?.state).toBe('completed');
  expect((await runtime.read(workspaceId, owner)).proposals.filter(item => item.jobId === job.id)).toHaveLength(1);
  runtime.close(); await runtime.idle();
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async () => { throw new ApiError(503, 'Provider still unavailable'); } });
  const failed = await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  expect((await runtime.read(workspaceId, owner)).jobs.find(item => item.id === failed.id)).toMatchObject({ state: 'failed', error: 'Provider still unavailable' });
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
});
