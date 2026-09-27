import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import type { InsightCategory } from '../shared/insights.js';
import type { ActionKind } from '../shared/policy.js';

export type FeedbackDecision = 'applied' | 'dismissed';
export type FeedbackEntry = { itemId: string; category: InsightCategory; confidence: number; decision: FeedbackDecision; at: string };
export type FeedbackBucket = { category: string; bucket: string; applied: number; dismissed: number; applyRate: number };
export type CalibrationSuggestion = { kind: ActionKind; suggestedShow: number | null; sampleSize: number; note?: string };

const categories = new Set<InsightCategory>(['connection', 'layout', 'loader', 'purpose', 'work_area', 'duplicate',
  'conflict', 'stale', 'missing_steps', 'reviewer', 'merge', 'cross_connection', 'relation', 'supersedes', 'quality',
  'tag', 'task', 'move', 'gap']);

/** Categories map onto the one policy control their feedback should calibrate. Purpose and work area
 * share the "label" control; duplicate, relation, supersedes, and quality have no single matching control. */
const categoryKind: Partial<Record<InsightCategory, ActionKind>> = {
  connection: 'link', purpose: 'label', work_area: 'label', tag: 'tag', reviewer: 'reviewer', loader: 'loader',
  merge: 'merge', cross_connection: 'cross_link', task: 'task_update', stale: 'stale', missing_steps: 'steps',
  conflict: 'conflict', gap: 'gap', layout: 'layout', move: 'move',
};

function feedbackDir(root: string): string { return path.join(root, 'jev-feedback'); }

export async function recordFeedback(root: string, canvasId: string, input: Record<string, unknown>): Promise<FeedbackEntry> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(canvasId)) throw new ApiError(400, 'Invalid canvas ID');
  const { itemId, category, confidence, decision } = input;
  if (typeof itemId !== 'string' || !itemId || itemId.length > 200 || /[\r\n]/.test(itemId)
    || !categories.has(category as InsightCategory) || typeof confidence !== 'number' || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || (decision !== 'applied' && decision !== 'dismissed')) {
    throw new ApiError(400, 'Invalid insight feedback');
  }
  const entry: FeedbackEntry = { itemId, category: category as InsightCategory, confidence, decision, at: new Date().toISOString() };
  await mkdir(feedbackDir(root), { recursive: true });
  await appendFile(path.join(feedbackDir(root), `${canvasId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

function bucket(confidence: number): string {
  return confidence >= 0.85 ? '0.85+' : confidence >= 0.75 ? '0.75–0.85' : '0.65–0.75';
}

function bucketFloor(label: string): number { return label === '0.85+' ? 0.85 : label === '0.75–0.85' ? 0.75 : 0.65; }

async function allFeedbackEntries(root: string): Promise<FeedbackEntry[]> {
  let files: string[];
  try { files = await readdir(feedbackDir(root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: FeedbackEntry[] = [];
  for (const file of files.filter(name => /^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/.test(name))) {
    const source = await readFile(path.join(feedbackDir(root), file), 'utf8');
    for (const line of source.split('\n').filter(Boolean)) {
      let entry: FeedbackEntry;
      try { entry = JSON.parse(line) as FeedbackEntry; } catch { continue; }
      if (!categories.has(entry.category) || !['applied', 'dismissed'].includes(entry.decision)
        || typeof entry.confidence !== 'number' || entry.confidence < 0.65 || entry.confidence > 1) continue;
      entries.push(entry);
    }
  }
  return entries;
}

export async function feedbackSummary(root: string): Promise<FeedbackBucket[]> {
  const counts = new Map<string, { category: string; bucket: string; applied: number; dismissed: number }>();
  for (const entry of await allFeedbackEntries(root)) {
    const level = bucket(entry.confidence);
    const key = `${entry.category}:${level}`;
    const count = counts.get(key) ?? { category: entry.category, bucket: level, applied: 0, dismissed: 0 };
    count[entry.decision]++;
    counts.set(key, count);
  }
  return [...counts.values()].map(count => ({ ...count, applyRate: count.applied / (count.applied + count.dismissed) }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.bucket.localeCompare(b.bucket));
}

const minCalibrationDecisions = 20;
const minCalibrationApplyRate = 0.6;

/** For each policy control with mapped feedback (aggregated across every canvas and every category that shares
 * that control), the lowest confidence bucket whose apply rate is high enough on enough decisions to suggest as
 * a Show threshold. Returns `suggestedShow: null` with a note when there is not enough reviewed feedback yet. */
export async function jevCalibration(root: string): Promise<CalibrationSuggestion[]> {
  const byKind = new Map<ActionKind, FeedbackEntry[]>();
  for (const entry of await allFeedbackEntries(root)) {
    const kind = categoryKind[entry.category];
    if (!kind) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), entry]);
  }
  return [...byKind.entries()].map(([kind, entries]) => {
    const buckets = new Map<string, { applied: number; dismissed: number }>();
    for (const entry of entries) {
      const level = bucket(entry.confidence);
      const count = buckets.get(level) ?? { applied: 0, dismissed: 0 };
      count[entry.decision]++;
      buckets.set(level, count);
    }
    const ordered = [...buckets.entries()].sort((a, b) => bucketFloor(a[0]) - bucketFloor(b[0]));
    const match = ordered.find(([, count]) => {
      const total = count.applied + count.dismissed;
      return total >= minCalibrationDecisions && count.applied / total >= minCalibrationApplyRate;
    });
    return { kind, suggestedShow: match ? bucketFloor(match[0]) : null, sampleSize: entries.length,
      ...(match ? {} : { note: 'Not enough data' }) };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
}
