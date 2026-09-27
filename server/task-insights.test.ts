import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { analyzeTaskInsights } from './task-insights.js';
import type { JevAnswer, JevDecider, JevQuestion } from './jev.js';

async function freshStore(directories: string[]): Promise<CanvasStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-tasks-'));
  directories.push(directory);
  const store = new CanvasStore(directory);
  await store.init();
  await store.updateSettings({ jevApiKey: 'test-key' });
  return store;
}

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('task insights', () => {
  it('scores priority and effort, suggests a document, and reuses cached answers', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jev-tasks-'));
    directories.push(directory);
    const store = new CanvasStore(directory);
    await store.init();
    await store.updateSettings({ jevApiKey: 'test-key' });
    const task = await store.createTask('product-roadmap', { title: 'Update launch flow', detail: 'Document the launch flow' }, 'Tester');
    const implementation: JevDecider = async (_key, state, questions) => {
      expect((state as { documents: { title: string }[] }).documents[0].title).toBe('Launch flow');
      return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, JevAnswer] => [id, question.type === 'noul'
        ? { type: 'noul', noul: id.endsWith('_blocked') ? 0.1 : id.endsWith('_about') ? 0.8 : 0.05 }
        : { type: 'score', score: id.endsWith('_urgency') || id.endsWith('_importance') ? 4 : 1, confidence: 1,
          probabilities: { '0': 0, '1': id.endsWith('_effort') ? 1 : 0,
            '2': 0, '3': 0, '4': id.endsWith('_urgency') || id.endsWith('_importance') ? 1 : 0 } }]));
    };
    const decider = vi.fn(implementation);
    const first = await analyzeTaskInsights(store, 'product-roadmap', decider);
    expect(first.scores[task.id]).toMatchObject({ priority: 1, effort: 0.25, blocked: 0.1, priorityPerEffort: 7 });
    expect(first.items.find(item => item.id === `task-attach-${task.id}`)?.proposedAction.patch.blockIds).toContain('launch-flow');
    await analyzeTaskInsights(store, 'product-roadmap', decider);
    expect(decider).toHaveBeenCalledTimes(1);
  });

  it('asks urgency and importance as separate score questions and adds true/false criteria to blocked', async () => {
    const store = await freshStore(directories);
    await store.createTask('product-roadmap', { title: 'Ship report', detail: 'Ship the report' }, 'Tester');
    let seen: Record<string, JevQuestion> = {};
    const decider: JevDecider = async (_key, _state, questions) => {
      seen = questions;
      return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, JevAnswer] => [id, question.type === 'noul'
        ? { type: 'noul', noul: 0.1 } : { type: 'score', score: 2, confidence: 1, probabilities: { '2': 1 } }]));
    };
    await analyzeTaskInsights(store, 'product-roadmap', decider);
    expect(seen.t0_urgency?.type).toBe('score');
    expect(seen.t0_importance?.type).toBe('score');
    expect(seen.t0_urgency).not.toBe(seen.t0_importance);
    const blocked = seen.t0_blocked;
    if (blocked?.type !== 'noul') throw new Error('Expected a noul question for t0_blocked');
    expect(Object.keys(blocked.criteria ?? {}).sort()).toEqual(['false', 'true']);
  });

  it('keeps priorityPerEffort a function of the chosen levels, not the probability spread', async () => {
    async function scoreFor(spread: number) {
      const store = await freshStore(directories);
      const task = await store.createTask('product-roadmap', { title: 'Ship report', detail: 'Ship it' }, 'Tester');
      const scoreAt = (level: number): JevAnswer => ({ type: 'score', score: level, confidence: 1,
        probabilities: Object.fromEntries([0, 1, 2, 3, 4].map(l => [String(l), l === level ? 1 - spread : spread / 4])) });
      const decider: JevDecider = async (_key, _state, questions) =>
        Object.fromEntries(Object.entries(questions).map(([id, question]): [string, JevAnswer] => [id, question.type === 'noul'
          ? { type: 'noul', noul: 0.1 }
          : scoreAt(id.endsWith('_urgency') ? 3 : id.endsWith('_importance') ? 4 : 1)]));
      const report = await analyzeTaskInsights(store, 'product-roadmap', decider);
      return report.scores[task.id];
    }
    const low = await scoreFor(0);
    const high = await scoreFor(0.2);
    expect(low.priorityPerEffort).toBe(6);
    expect(high.priorityPerEffort).toBe(6);
    expect(low.priority).not.toBe(high.priority);
  });

  it('processes tasks under bounded concurrency with deterministic output order', async () => {
    const store = await freshStore(directories);
    const tasks = await Promise.all(['One', 'Two', 'Three', 'Four'].map(name =>
      store.createTask('product-roadmap', { title: `Ship ${name}`, detail: `Ship the ${name} report` }, 'Tester')));
    const decider: JevDecider = async (_key, state, questions) => {
      const title = (state as { tasks: { title: string }[] }).tasks[0].title;
      await new Promise(resolve => setTimeout(resolve, title.endsWith('One') ? 15 : 0));
      return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, JevAnswer] => [id, question.type === 'noul'
        ? { type: 'noul', noul: 0.1 } : { type: 'score', score: 2, confidence: 1, probabilities: { '2': 1 } }]));
    };
    const report = await analyzeTaskInsights(store, 'product-roadmap', decider);
    expect(Object.keys(report.scores)).toEqual(tasks.map(task => task.id));
  });
});
