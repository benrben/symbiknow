import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { JEV_MODEL, onJevUsage, type JevUsage } from './jev.js';

/** $42 per 1B input tokens, output tokens are free. https://docs.typesafe.ai/models */
const usdPerBillionInputTokens = 42;

export type JevUsageTotals = { requests: number; questions: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
export type JevUsageSummary = { model: string; month: JevUsageTotals; today: JevUsageTotals };

function usageDir(root: string): string { return path.join(root, 'jev-usage'); }
function currentMonth(at: Date): string { return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`; }
function monthFile(root: string, month: string): string { return path.join(usageDir(root), `${month}.jsonl`); }

// One write chain per data directory so concurrent usage events never interleave partial JSON lines.
const writeChains = new Map<string, Promise<void>>();

function appendUsage(root: string, usage: JevUsage): void {
  const previous = writeChains.get(root) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(usageDir(root), { recursive: true });
    await appendFile(monthFile(root, currentMonth(new Date(usage.at))), `${JSON.stringify(usage)}\n`, { mode: 0o600 });
  }).catch(error => { console.error('Could not record Jev usage', error); });
  writeChains.set(root, next);
}

/** Subscribes to `onJevUsage` and appends each usage record under `DATA_DIR/jev-usage/<YYYY-MM>.jsonl`.
 * Never writes API keys or Jev state, only token counts and question counts. Returns an unsubscribe function. */
export function registerJevUsageLogging(root: string): () => void {
  return onJevUsage(usage => appendUsage(root, usage));
}

function emptyTotals(): JevUsageTotals { return { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }; }

function addUsage(totals: JevUsageTotals, usage: JevUsage): void {
  totals.requests += 1;
  totals.questions += usage.questions;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.estimatedCostUsd += (usage.inputTokens * usdPerBillionInputTokens) / 1_000_000_000;
}

function validUsage(value: unknown): value is JevUsage {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
    && typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
    && typeof usage.questions === 'number' && Number.isFinite(usage.questions)
    && typeof usage.at === 'string';
}

/** This month's and today's request counts, token counts, and estimated cost, plus the pinned model. */
export async function jevUsageSummary(root: string, now = new Date()): Promise<JevUsageSummary> {
  const month = emptyTotals();
  const today = emptyTotals();
  const todayKey = now.toISOString().slice(0, 10);
  let source: string;
  try { source = await readFile(monthFile(root, currentMonth(now)), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { model: JEV_MODEL, month, today };
    throw error;
  }
  for (const line of source.split('\n').filter(Boolean)) {
    let usage: unknown;
    try { usage = JSON.parse(line); } catch { continue; }
    if (!validUsage(usage)) continue;
    addUsage(month, usage);
    if (usage.at.slice(0, 10) === todayKey) addUsage(today, usage);
  }
  return { model: JEV_MODEL, month, today };
}
