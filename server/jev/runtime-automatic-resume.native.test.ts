import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { jevActions, type JevPrincipal } from '../../shared/jev-types.js';
import type { JevAnswer, JevQuestion } from '../jev.js';
import { CanvasStore } from '../storage.js';
import { evaluateJevAction } from './actions.js';
import { JevRuntime } from './runtime.js';

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

async function entered(promise: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Automatic work did not resume after Pause was cleared')), 1000);
    })]);
  } finally { clearTimeout(timeout!); }
}

it.each(['profile', 'label'] as const)
  ('resumes %s after two Pause cycles in one clock minute without action requests', async action => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const root = await mkdtemp(path.join(tmpdir(), 'jev-automatic-resume-'));
    const holds = [0, 1].map(() => ({ entered: deferred(), released: deferred() }));
    let runtime: JevRuntime | undefined; let held = 0; let calls = 0;
    try {
      const store = new CanvasStore(root); await store.init(); await store.deleteWorkspace('acme-team');
      const workspace = await store.createWorkspace({ name: 'Automatic resume' });
      const canvas = await store.createCanvas(workspace.id, { name: 'Atlas' });
      const source = await store.createBlock(canvas.id, { title: 'Atlas', content: '# Atlas\nOwner: Alice\nAtlas coordinate specification: every northern star entry records right ascension and declination.' });
      await store.createTask(canvas.id, { title: 'Atlas release', detail: 'Deliver Atlas release requirements.' }, 'Browser');
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-04T12:00:00.000Z');
      runtime = new JevRuntime(store, { startTimer: false,
        evaluate: async (context, request) => {
          if (request.action === action && held < holds.length) {
            const hold = holds[held++]; hold.entered.resolve(); await hold.released.promise;
          }
          return evaluateJevAction(context, request);
        },
        decider: async (_key, _state, questions) => {
          calls += 1;
          return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, decision(id, question)]));
        } });
      await runtime.idle();
      expect((await runtime.read(workspace.id, owner)).jobs).toEqual([]);
      await store.updateSettings({ secrets: { TYPESAFE_API_KEY: 'native-resume-provider' } });
      await runtime.tick(); await entered(holds[0].entered.promise);
      for (const [index, hold] of holds.entries()) {
        await runtime.configure(workspace.id, { paused: true }, owner);
        expect((await runtime.read(workspace.id, owner)).jobs.filter(job => job.request.action === action && job.state === 'cancelled')).toHaveLength(index + 1);
        await runtime.configure(workspace.id, { paused: false }, owner);
        hold.released.resolve();
        if (index === 0) await entered(holds[1].entered.promise);
      }
      await runtime.idle();
      const completed = await runtime.read(workspace.id, owner);
      expect(new Set(completed.jobs.filter(job => job.state === 'completed').map(job => job.request.action))).toEqual(new Set(jevActions));
      expect(completed.jobs.filter(job => ['queued', 'running', 'failed'].includes(job.state))).toEqual([]);
      expect(completed.proposals.filter(proposal => proposal.state === 'pending')).toEqual([]);
      expect(completed.profiles[`${canvas.id}:${source.id}`]).toMatchObject({ role: 'specification' });
      const reloaded = new CanvasStore(root); await reloaded.init();
      expect(await reloaded.getCanvasBlock(canvas.id, source.id)).toMatchObject({ content: source.content, tags: ['Atlas'] });
      const completedCalls = calls;
      await runtime.tick(); await runtime.idle();
      expect((await runtime.read(workspace.id, owner)).jobs).toEqual(completed.jobs);
      expect(calls).toBe(completedCalls);
      expect(Date.now()).toBe(Date.parse('2026-10-04T12:00:00.000Z'));
    } finally {
      holds.forEach(hold => hold.released.resolve());
      await runtime?.shutdown(); await rm(root, { recursive: true, force: true });
      vi.useRealTimers(); vi.unstubAllEnvs();
    }
  });
