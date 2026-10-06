import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage-files.js';

type Entry = { key: string; state: 'running' | 'complete' | 'failed'; updatedAt: string; value?: unknown; error?: string };
type Outcome<T> = { state: 'complete'; value: T; reused: boolean } | { state: 'interrupted' | 'failed'; reason: string };

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Entry>;
  return typeof entry.key === 'string' && ['running', 'complete', 'failed'].includes(entry.state ?? '');
}

function restoredOutcome<T>(entry: Entry): Outcome<T> {
  if (entry.state === 'complete') return { state: 'complete', value: entry.value as T, reused: true };
  return { state: entry.state === 'running' ? 'interrupted' : 'failed',
    reason: entry.error ?? 'The previous provider request did not finish durably. Start a new explicit question to retry.' };
}

/** Durable, bounded memoization for read-only paid judgments. Source and policy versions belong in the caller's key. */
export class SymbiJudgmentCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Outcome<unknown>>>();
  private persistence = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(root: string): Promise<SymbiJudgmentCache> {
    const cache = new SymbiJudgmentCache(path.join(root, 'symbi-judgments.json'));
    try {
      cache.restore(JSON.parse(await readFile(cache.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return cache;
  }

  private restore(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('Invalid judgment cache');
    for (const entry of value) if (validEntry(entry)) this.entries.set(entry.key, entry);
    if (this.entries.size > 256) throw new Error('Judgment cache exceeds its durable capacity');
  }

  private async save(): Promise<void> {
    while (this.entries.size > 256) {
      const oldestCompleted = [...this.entries].find(([, entry]) => entry.state !== 'running')?.[0];
      if (!oldestCompleted) throw new Error('Judgment cache cannot evict an active request');
      this.entries.delete(oldestCompleted);
    }
    const snapshot = [...this.entries.values()].slice(-256);
    const attempt = this.persistence.then(() => atomicJson(this.file, snapshot));
    this.persistence = attempt.catch(error => { console.error('Judgment cache persistence failed:', error); });
    await attempt;
  }

  async getOrRun<T>(key: string, run: () => Promise<T>): Promise<Outcome<T>> {
    const active = this.inFlight.get(key);
    if (active) return active as Promise<Outcome<T>>;
    const existing = this.entries.get(key);
    if (existing) return restoredOutcome<T>(existing);
    if (this.entries.size >= 256 && [...this.entries.values()].every(entry => entry.state === 'running')) {
      return { state: 'failed', reason: 'Judgment cache is full of active requests; no provider call was made.' };
    }
    const work = (async (): Promise<Outcome<T>> => {
      this.entries.set(key, { key, state: 'running', updatedAt: new Date().toISOString() });
      try { await this.save(); }
      catch {
        this.entries.delete(key);
        return { state: 'failed', reason: 'Judgment cache could not reserve the request durably; no provider call was made.' };
      }
      try {
        const value = await run();
        this.entries.delete(key);
        this.entries.set(key, { key, state: 'complete', updatedAt: new Date().toISOString(), value });
        await this.save();
        return { state: 'complete', value, reused: false };
      } catch (error) {
        this.entries.set(key, { key, state: 'failed', updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message.slice(0, 200) : 'Provider request failed' });
        await this.save();
        return { state: 'failed', reason: error instanceof Error ? error.message : 'Provider request failed' };
      }
    })();
    this.inFlight.set(key, work);
    try { return await work; }
    finally { this.inFlight.delete(key); }
  }
}
