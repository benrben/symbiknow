import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { jevActions, type JevActionRequest, type JevJob, type JevPrincipal } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction, type JevEvaluationContext } from './actions.js';
import { automaticConfidenceThresholds } from './automatic-policy.js';
import { updatedJevSettings } from './configuration.js';
import { evaluationContext } from './context.js';
import { boundaryOwner, queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { JevRuntime } from './runtime.js';
import { recordJevCandidates } from './runtime-proposals.js';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

function decision(id: string, question: JevQuestion): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: ['addressesAi', 'conflict', 'synonymous'].includes(id) ? 0.01 : 0.98 };
  if (question.type === 'score') return { type: 'score', score: 2, confidence: 0.98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 2 ? 1 : 0])) };
  const keys = Object.keys(question.criteria);
  const selected = ({ role: 'specification', pair: 'none', parent: 'none' } as Record<string, string>)[id] ?? keys[0];
  return { type: 'choice', choice: selected, confidence: 0.98,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) };
}

function evaluateCutoffActions(context: JevEvaluationContext, request: JevActionRequest) {
  return ['profile', 'label'].includes(request.action)
    ? evaluateJevAction(context, request) : Promise.resolve({ result: {}, proposals: [] });
}

async function commitProfile(native: QueueBoundaryFixture, job: JevJob): Promise<void> {
  const state = await native.files.read(native.workspaceId);
  const context = await evaluationContext(native.store, native.workspaceId, state, job.request, boundaryOwner, new AbortController().signal);
  context.apiKey = 'native-cutoff-cycles';
  context.decider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = decision(id, question);
    if (id === 'role' && answer.type === 'choice') answer.confidence = 0.75;
    return [id, answer];
  }));
  const current = state.jobs.find(item => item.id === job.id)!;
  recordJevCandidates(state, current, await evaluateJevAction(context, job.request), context);
  current.state = 'completed'; await native.files.write(native.workspaceId, state);
  for (const proposalId of current.proposalIds) {
    await native.files.serial(native.workspaceId, () => native.executor.applyInside(native.workspaceId, proposalId, boundaryOwner, true));
  }
}

it('cancels an in-flight profile for a new cutoff and automatically refreshes dependent work after later partial updates', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-confidence-settings-'));
  const entered = deferred(); const released = deferred();
  const evaluations: Array<{ action: string; profileThreshold: number | undefined }> = [];
  let runtime: JevRuntime | undefined;
  try {
    const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    const workspace = await store.createWorkspace({ name: 'Confidence settings' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Atlas' });
    const source = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nAtlas release requirements.' });
    runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-confidence-provider',
      evaluate: async (context, request) => {
        evaluations.push({ action: request.action, profileThreshold: context.settings.confidenceThresholds?.profile });
        if (evaluations.length === 1) { entered.resolve(); await released.promise; }
        return evaluateCutoffActions(context, request);
      },
      decider: async (_key, _state, questions) => Object.fromEntries(Object.entries(questions)
        .map(([id, question]) => [id, decision(id, question)])) });
    await entered.promise;
    await runtime.configure(workspace.id, { confidenceThresholds: { profile: 0.85 } }, owner);
    expect((await runtime.read(workspace.id, owner)).jobs.filter(job => job.request.action === 'profile' && job.state === 'cancelled')).toHaveLength(1);
    released.resolve(); await runtime.idle();
    const completed = await runtime.read(workspace.id, owner);
    expect(new Set(completed.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
    expect(evaluations.filter(item => item.action === 'profile').map(item => item.profileThreshold)).toEqual([0.7, 0.85]);
    expect(completed.settings.confidenceThresholds).toEqual({ ...automaticConfidenceThresholds(), profile: 0.85 });
    await runtime.configure(workspace.id, { confidenceThresholds: { label: 0.9 } }, owner); await runtime.idle();
    const refreshed = await runtime.read(workspace.id, owner);
    expect(evaluations.filter(item => item.action === 'label')).toHaveLength(2);
    expect(evaluations.filter(item => item.action === 'profile')).toHaveLength(2);
    expect(refreshed.settings.confidenceThresholds).toEqual({ ...automaticConfidenceThresholds(), profile: 0.85, label: 0.9 });
    const finishedEvaluations = evaluations.length;
    await runtime.configure(workspace.id, { confidenceThresholds: { label: 0.9 } }, owner); await runtime.idle();
    expect(evaluations).toHaveLength(finishedEvaluations);
    expect((await runtime.read(workspace.id, owner)).jobs).toEqual(refreshed.jobs);
    await expect(runtime.configure(workspace.id, { confidenceThresholds: { label: 1.01 } }, owner)).rejects.toMatchObject({ status: 400 });
    expect((await new JevWorkspaceFiles(root).read(workspace.id)).settings.confidenceThresholds).toEqual(refreshed.settings.confidenceThresholds);
    const reloaded = new CanvasStore(root); await reloaded.init();
    expect((await reloaded.getCanvasBlock(canvas.id, source.id)).content).toBe(source.content);
  } finally {
    released.resolve(); await runtime?.shutdown(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
});

it('rechecks completed profile classifications after cutoff changes, preserves scores, and upgrades an unstamped legacy profile once', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-profile-confidence-'));
  const profileThresholds: Array<number | undefined> = [];
  let runtime: JevRuntime | undefined;
  try {
    const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
    const workspace = await store.createWorkspace({ name: 'Profile confidence' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Atlas' });
    const source = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nAtlas release requirements.' });
    const files = new JevWorkspaceFiles(root); const initial = emptyJevWorkspace();
    initial.settings.confidenceThresholds!.profile = 0.65; await files.write(workspace.id, initial);
    runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-profile-confidence',
      evaluate: async (context, request) => {
        if (request.action === 'profile') profileThresholds.push(context.settings.confidenceThresholds?.profile);
        const result = await evaluateCutoffActions(context, request);
        for (const candidate of result.proposals) {
          if (candidate.action === 'profile' && candidate.mutation.kind === 'derived') candidate.mutation.values.profileConfidenceThreshold = -1;
        }
        return result;
      },
      decider: async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const answer = decision(id, question);
        if (id === 'role' && answer.type === 'choice') answer.confidence = 0.75;
        return [id, answer];
      })) });
    await runtime.idle();
    const profileKey = `${canvas.id}:${source.id}`;
    const accepted = await runtime.read(workspace.id, owner);
    expect(accepted.profiles[profileKey]).toMatchObject({ role: 'specification', profileConfidenceThreshold: 0.65, keyPassageSelectionConfidence: 0.98 });
    const quality = accepted.profiles[profileKey].qualityRubric;
    await runtime.configure(workspace.id, { confidenceThresholds: { profile: 0.85 } }, owner); await runtime.idle();
    const rechecked = await runtime.read(workspace.id, owner);
    expect(profileThresholds).toEqual([0.65, 0.85]);
    expect(rechecked.jobs.filter(job => job.state === 'completed')).toHaveLength(jevActions.length * 2);
    expect(rechecked.profiles[profileKey]).toMatchObject({ role: 'unknown', profileConfidenceThreshold: 0.85, keyPassageSelectionConfidence: 0.98 });
    expect(rechecked.profiles[profileKey].qualityRubric).toEqual(quality);
    const legacy = await files.read(workspace.id);
    delete legacy.profiles[profileKey].profileConfidenceThreshold;
    delete legacy.profiles[profileKey].profileEvaluationId; await files.write(workspace.id, legacy);
    await runtime.tick(); await runtime.idle();
    expect(profileThresholds).toEqual([0.65, 0.85, 0.85]);
    expect((await files.read(workspace.id)).profiles[profileKey].profileConfidenceThreshold).toBe(0.85);
    const upgraded = await runtime.read(workspace.id, owner);
    await runtime.configure(workspace.id, { confidenceThresholds: { profile: 0.85 } }, owner); await runtime.tick(); await runtime.idle();
    expect(profileThresholds).toEqual([0.65, 0.85, 0.85]);
    expect((await runtime.read(workspace.id, owner)).jobs).toEqual(upgraded.jobs);
  } finally {
    await runtime?.shutdown(); await rm(root, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs();
  }
});

it('does not reuse completed profile history when two cutoff cycles occur in the same clock minute', async () => {
  const native = await queueBoundaryFixture();
  try {
    await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-04T12:00:00.000Z');
    const evaluated = new Set<string>();
    for (const cutoff of [0.65, 0.85, 0.65, 0.85, 0.65]) {
      const state = await native.files.read(native.workspaceId);
      state.settings = updatedJevSettings(state.settings, { confidenceThresholds: { profile: cutoff } });
      await native.files.write(native.workspaceId, state); await native.maintenance.reconcile(await native.workspace());
      const queued = (await native.files.read(native.workspaceId)).jobs.find(job => job.request.action === 'profile' && job.state === 'queued')!;
      expect(queued).toBeDefined(); expect(evaluated.has(queued.id)).toBe(false);
      evaluated.add(queued.id); await commitProfile(native, queued);
      expect((await native.files.read(native.workspaceId)).profiles[`${native.canvasId}:${native.primary.id}`]).toMatchObject({
        profileConfidenceThreshold: cutoff, role: cutoff === 0.65 ? 'specification' : 'unknown' });
    }
    await native.maintenance.reconcile(await native.workspace());
    expect((await native.files.read(native.workspaceId)).jobs.filter(job => job.request.action === 'profile')).toHaveLength(5);
    expect(evaluated.size).toBe(5);
  } finally { await native.close(); vi.useRealTimers(); }
});

it('keeps invalid persisted confidence settings explicit instead of replacing them during migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-confidence-recovery-'));
  try {
    const files = new JevWorkspaceFiles(root);
    for (const confidenceThresholds of [null, { digest: 0.9 }, { file: 0.4 }]) {
      const state = emptyJevWorkspace(); delete state.settings.automaticPolicyVersion;
      state.settings.confidenceThresholds = confidenceThresholds as never;
      await files.write('workspace', state);
      await expect(files.read('workspace')).rejects.toMatchObject({ status: 503, message: 'Symbi Reflex processing settings require recovery' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
