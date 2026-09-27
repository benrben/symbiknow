import { createHash } from 'node:crypto';
import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import type { TaskInsightReport, TaskScore, TaskSuggestion } from '../shared/insights.js';
import { effectiveJevPolicy } from '../shared/policy.js';
import { excerpt } from '../shared/excerpt.js';
import { documentText } from '../shared/document-text.js';
import { tokenize } from './similarity.js';
import { JevCache } from './jev-cache.js';
import { expectedScore, noulAnswer, scoreAnswer, topScore } from './jev-answers.js';
import { decideWithJev, type JevAnswer, type JevDecider, type JevQuestion } from './jev.js';
import { taskDocumentQuestions, taskSuggestions } from './relations.js';
import { ApiError, type CanvasStore } from './storage.js';

const concurrency = 6;

async function mapLimited<T, U>(values: T[], limit: number, work: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

function candidates(task: CanvasTask, blocks: CanvasBlock[]): CanvasBlock[] {
  const words = new Set(tokenize(`${task.title} ${task.detail}`));
  const ranked = blocks.map(block => {
    const terms = tokenize(`${block.title} ${block.title} ${documentText(block.content)}`);
    const matches = terms.filter(word => words.has(word)).length;
    return { block, score: matches / Math.sqrt(Math.max(terms.length, 1)) };
  }).sort((a, b) => b.score - a.score || a.block.title.localeCompare(b.block.title));
  return [...blocks.filter(block => task.blockIds.includes(block.id)), ...ranked.map(entry => entry.block)]
    .filter((block, index, all) => all.findIndex(item => item.id === block.id) === index).slice(0, 5);
}

/** Scores open tasks and relates them to their nearest documents. Nothing is changed until a suggestion is applied. */
export async function analyzeTaskInsights(store: CanvasStore, canvasId: string,
  decider: JevDecider = decideWithJev): Promise<TaskInsightReport> {
  const [canvas, tasks, settings] = await Promise.all([store.getCanvas(canvasId), store.listTasks(canvasId), store.getSettings()]);
  const open = tasks.filter(task => task.status !== 'done');
  const report: TaskInsightReport = { items: [], scores: {} };
  if (!open.length) return report;
  const apiKey = await store.getJevApiKey();
  if (!apiKey) throw new ApiError(400, 'Set a TypeSafe Jev API key in Settings before analyzing tasks');
  const policy = effectiveJevPolicy(settings.jevPolicy);
  const cache = await JevCache.load(store.root, canvasId);

  const results = await mapLimited(open, concurrency, async (task): Promise<{ taskId: string; score: TaskScore; items: TaskSuggestion[] }> => {
    const docs = candidates(task, canvas.blocks);
    const state = { tasks: [{ title: task.title, detail: task.detail, status: task.status,
      attachedTitles: task.blockIds.map(id => canvas.blocks.find(block => block.id === id)?.title).filter(Boolean) }],
    documents: docs.map(block => ({ title: block.title,
      content: excerpt(documentText(block.content), { budget: 1500, focus: 'claims' }) })) };
    const questions: Record<string, JevQuestion> = taskDocumentQuestions(0, task, docs);
    questions.t0_urgency = { type: 'score', instructions: 'How urgent is state.tasks[0]?',
      criteria: ['Can wait', 'Low urgency', 'Normal urgency', 'High urgency', 'Urgent'] };
    questions.t0_importance = { type: 'score', instructions: 'How important is state.tasks[0]?',
      criteria: ['Not important', 'Minor', 'Normal importance', 'Important', 'Critical'] };
    questions.t0_effort = { type: 'score', instructions: 'How much effort does state.tasks[0] require?',
      criteria: ['Minutes', 'Hours', 'A day', 'Several days', 'Weeks'] };
    questions.t0_blocked = { type: 'noul',
      instructions: 'Does state.tasks[0] or its documents mention an unmet dependency that blocks completion?',
      criteria: { true: 'An unmet dependency blocks completion', false: 'No unmet dependency blocks completion' } };
    const answers: Record<string, JevAnswer> = {};
    const missing: Record<string, JevQuestion> = {};
    const keyFor = (question: JevQuestion, id: string) => {
      const position = Number(id.match(/^t(\d+)_/)?.[1]);
      if (position !== 0) throw new ApiError(502, `Invalid task question: ${id}`);
      const family = id.replace(/^t\d+_/, '').replace(/^d\d+_/, 'document_');
      return { questionFamily: `task_${family}`, questionVersion: '1',
        contentHash: createHash('sha256').update(JSON.stringify({ task: [task.title, task.detail, task.status, task.blockIds],
          documents: docs.map(block => [block.id, block.contentHash]) })).digest('hex'), question };
    };
    for (const [id, question] of Object.entries(questions)) {
      const cached = cache.get(keyFor(question, id));
      if (cached) answers[id] = cached;
      else missing[id] = question;
    }
    if (Object.keys(missing).length) {
      const fresh = await decider(apiKey, state, missing);
      for (const [id, value] of Object.entries(fresh)) { answers[id] = value; cache.set(keyFor(missing[id], id), value); }
    }
    const urgency = scoreAnswer(answers, 't0_urgency');
    const importance = scoreAnswer(answers, 't0_importance');
    const effort = scoreAnswer(answers, 't0_effort');
    const blocked = noulAnswer(answers, 't0_blocked');
    const priority = (expectedScore(urgency, 5) + expectedScore(importance, 5)) / 2;
    const effortScore = expectedScore(effort, 5);
    /** A ranking key from discrete chosen levels, not the continuous priority/effort, so equal levels always sort equally. */
    const priorityPerEffort = topScore(urgency) + topScore(importance) - topScore(effort);
    const score: TaskScore = { priority, effort: effortScore, blocked, priorityPerEffort };
    return { taskId: task.id, score, items: taskSuggestions(0, task, docs, answers, policy) };
  });

  for (const result of results) {
    report.scores[result.taskId] = result.score;
    report.items.push(...result.items);
  }
  await cache.save();
  return report;
}
