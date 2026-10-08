import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { decideWithJev, type JevAnswer, type JevDecider, type JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import type { StoredCanvas } from '../storage-shapes.js';
import { evaluateJevAction } from './actions.js';
import { JevRuntime } from './runtime.js';
import { sourceSnapshot } from './stamps.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from './actions/question-state-pool.test.helpers.js';

const owner = { id: 'first-filing-owner', kind: 'user' as const, access: 'write' as const, canApprove: true, canConfigure: true };
const body = '# Authentication\n\nAuthentication verifies user identity before the service issues a protected session.';
type InitialMembership = 'ordinary' | 'unmanaged-empty' | 'manual-group' | 'pinned-empty';

function localQuestion(key: string, state: Record<string, unknown>) {
  let local = state;
  let match: RegExpExecArray | null;
  while ((match = /^(\d+)__(.+)$/.exec(key))) {
    local = (local.questionSets as Record<string, unknown>[])[Number(match[1])]; key = match[2];
  }
  return { key, state: resolveSharedQuestionSources(local, state.sourceStates) };
}
function chosen(question: Extract<JevQuestion, { type: 'choice' }>, value: string): JevAnswer {
  return { type: 'choice', choice: value, confidence: .99,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === value)])) };
}
function localAnswer(id: string, question: JevQuestion, state: Record<string, unknown>): JevAnswer {
  if (question.type === 'noul') {
    const index = /^logicalTopic_(\d+)$/.exec(id)?.[1];
    const topics = state.logicalTopicCandidates as Array<{ name: string }> | undefined;
    const supported = index === undefined || topics?.[Number(index)].name.toLocaleLowerCase() === 'authentication';
    return { type: 'noul', noul: supported ? .99 : 0 };
  }
  if (question.type !== 'choice') throw new Error('Unexpected first-filing question');
  if (id === 'role') return chosen(question, 'reference');
  if (['place', 'gate'].includes(id)) {
    const groups = state.groups as Array<{ key: string; option: string }>;
    return chosen(question, groups.find(group => group.key === 'custom:authentication')?.option ?? 'none');
  }
  const options = Object.entries(question.criteria);
  const exact = options.find(([, description]) => description.includes('Authentication verifies user identity'))?.[0];
  if (id.includes('Evidence') || id === 'evidence' || id === 'keyPassage') return chosen(question, exact ?? 'none');
  const topic = options.find(([, description]) => description.includes('(custom:authentication)'))?.[0];
  return chosen(question, topic ?? 'none');
}

async function firstFilingFixture(membership: InitialMembership) {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-first-filing-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'First filing' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const source = await store.createBlock(canvas.id, { title: 'Authentication', content: body }, 'Browser');
  if (membership !== 'ordinary') {
    const file = path.join(root, 'canvases', `${canvas.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
    const block = raw.blocks.find(block => block.id === source.id)!;
    if (membership === 'manual-group') block.group = 'custom:manual-review';
    block.jevOwnership = { managed: [], pins: membership === 'pinned-empty' ? ['group'] : [], removedLabels: [], removedLinks: [] };
    await atomicJson(file, raw);
  }
  const actions: string[] = [];
  const decider = vi.fn<JevDecider>(async (_key, input, questions) => {
    const state = input as Record<string, unknown>;
    const answers = Object.fromEntries(Object.entries(questions).map(([key, submitted]) => {
      const local = localQuestion(key, state);
      return [key, localAnswer(local.key, resolveSharedQuestionTexts(submitted, state.questionTexts), local.state)];
    }));
    return decideWithJev(_key, input, questions, async () => Response.json({ answers }), { maxRetries: 0 });
  });
  const runtime = new JevRuntime(store, { startTimer: false, apiKey: 'local-first-filing-fixture', decider,
    documentExecution: true, evaluate: async (context, request) => {
      actions.push(request.action);
      return ['profile', 'label', 'file'].includes(request.action) ? evaluateJevAction(context, request) : { result: {}, proposals: [] };
    } });
  return { root, store, workspace, canvas, source, runtime, actions, decider,
    close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

it.each(['ordinary', 'unmanaged-empty'] as const)('durably files an %s ungrouped source after an actual fresh profile using production subject candidates', async membership => {
  const f = await firstFilingFixture(membership);
  try {
    await f.runtime.idle();
    const state = await f.runtime.read(f.workspace.id, owner);
    expect(state.jobs.filter(job => ['failed', 'queued', 'running'].includes(job.state))).toEqual([]);
    expect(f.actions.indexOf('file')).toBeGreaterThan(f.actions.indexOf('profile'));
    const filed = state.proposals.find(proposal => proposal.action === 'file' && proposal.mutation.kind === 'document');
    expect(filed).toMatchObject({ state: 'applied', mutation: { patch: { group: 'custom:authentication' } } });
    const definition = state.proposals.find(proposal => proposal.action === 'file' && proposal.mutation.kind === 'vocabulary');
    expect(definition).toMatchObject({ state: 'applied', mutation: { term: { name: 'Authentication', groupKey: 'custom:authentication' } } });
    expect(state.receipts.findIndex(receipt => receipt.proposalId === definition!.id))
      .toBeLessThan(state.receipts.findIndex(receipt => receipt.proposalId === filed!.id));
    const reloaded = new CanvasStore(f.root); await reloaded.init();
    const saved = await reloaded.getCanvasBlock(f.canvas.id, f.source.id);
    expect(saved).toMatchObject({ group: 'custom:authentication', content: body });
    expect(saved.jevOwnership!.managed).toContain('group');
    expect(saved.jevOwnership!.pins).not.toContain('group');
    expect(filed!.evidence.length).toBeGreaterThan(0);
    for (const passage of filed!.evidence) {
      expect(passage.source.blockId).toBe(saved.id);
      expect(passage.source.contentHash).toBe(saved.contentHash);
      expect(body.slice(passage.start, passage.end)).toBe(passage.quote);
    }
    expect(state.profiles[`${f.canvas.id}:${saved.id}`].source).toMatchObject({
      incarnation: saved.incarnation, sourceGeneration: saved.sourceGeneration, contentHash: saved.contentHash });
    expect(sourceSnapshot(f.workspace.id, f.canvas.id, saved).contentHash).toBe(f.source.contentHash);
    expect(f.decider).toHaveBeenCalled();
    const admission = f.decider.mock.calls.find(([, input, questions]) => 'place' in questions && 'gate' in questions
      && (input as { groups?: Array<{ key: string }> }).groups?.some(group => group.key === 'custom:authentication'));
    expect(admission).toBeDefined();
    expect((admission![1] as { groups: Array<{ key: string; option: string }> }).groups)
      .toEqual([expect.objectContaining({ key: 'custom:authentication', option: 'A' })]);
  } finally { await f.close(); }
});

it.each(['manual-group', 'pinned-empty'] as const)('durably records %s filing protection without evaluating or proposing a group', async membership => {
  const f = await firstFilingFixture(membership);
  try {
    await f.runtime.idle();
    expect(f.actions).toContain('profile'); expect(f.actions).not.toContain('file');
    const state = await f.runtime.read(f.workspace.id, owner);
    expect(state.jobs.find(job => job.request.action === 'file')).toMatchObject({ state: 'completed', proposalIds: [],
      result: { reason: 'A field is pinned or managed manually' } });
    expect(state.proposals.filter(proposal => proposal.action === 'file')).toEqual([]);
    const saved = await new CanvasStore(f.root).getCanvasBlock(f.canvas.id, f.source.id);
    expect(saved.group).toBe(membership === 'manual-group' ? 'custom:manual-review' : undefined);
    expect(saved.content).toBe(body);
  } finally { await f.close(); }
});
