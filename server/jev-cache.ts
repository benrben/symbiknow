import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JEV_MODEL, type JevAnswer, type JevQuestion } from './jev.js';

const ttl = 30 * 24 * 60 * 60 * 1_000;
const maxEntries = 5_000;
const canvasIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export type JevCacheKey = {
  questionFamily: string;
  questionVersion: string;
  contentHash: string;
  extraKey?: string;
  /** When given, a change to the question text or criteria invalidates the entry, without bumping questionVersion by hand. */
  question?: JevQuestion;
};
export type JevCacheInput = JevCacheKey;

type CacheEntry = { answer: JevAnswer; createdAt: number; lastUsedAt: number };

/** Deterministic JSON with sorted object keys, so equivalent values always hash the same way. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function jevCacheKey({ questionFamily, questionVersion, contentHash, extraKey = '', question }: JevCacheKey): string {
  return createHash('sha256')
    .update(stableStringify({ model: JEV_MODEL, questionFamily, questionVersion, contentHash, extraKey, question }))
    .digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validAnswer(value: unknown): value is JevAnswer {
  if (!record(value)) return false;
  if (value.type === 'noul') return probability(value.noul);
  if (!probability(value.confidence) || !record(value.probabilities)
    || !Object.values(value.probabilities).every(probability)) return false;
  if (value.type === 'choice') return typeof value.choice === 'string';
  return value.type === 'score' && typeof value.score === 'number' && Number.isFinite(value.score)
    && (value.legend === undefined || (record(value.legend) && Object.values(value.legend).every(item => typeof item === 'string')));
}

function answerMatchesQuestion(answer: JevAnswer, question: JevQuestion): boolean {
  if (answer.type !== question.type) return false;
  if (question.type === 'choice') return answer.type === 'choice' && Object.keys(question.criteria).includes(answer.choice);
  if (question.type === 'score') return answer.type === 'score' && answer.score >= 0 && answer.score <= question.criteria.length - 1;
  return true;
}

function answerOnly(answer: JevAnswer): JevAnswer {
  if (answer.type === 'noul') return { type: 'noul', noul: answer.noul };
  if (answer.type === 'choice') return {
    type: 'choice', choice: answer.choice, probabilities: { ...answer.probabilities }, confidence: answer.confidence,
  };
  return {
    type: 'score', score: answer.score, probabilities: { ...answer.probabilities }, confidence: answer.confidence,
    ...(answer.legend === undefined ? {} : { legend: { ...answer.legend } }),
  };
}

function validEntry(value: unknown): value is CacheEntry {
  return record(value) && validAnswer(value.answer)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt);
}

/** Derived Jev answers for one canvas. Cache loss affects only speed, never document data. */
export class JevCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;
  private accessClock = 0;

  private constructor(private readonly file: string, private readonly now: () => number) {}

  static async load(dataDir: string, canvasId: string, now: () => number = Date.now): Promise<JevCache> {
    if (!canvasIdPattern.test(canvasId)) throw new Error('Invalid canvas ID');
    const cache = new JevCache(path.join(dataDir, 'jev-cache', `${canvasId}.json`), now);
    let source: string;
    try { source = await readFile(cache.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cache;
      throw error;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(source) as unknown; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      cache.dirty = true;
      return cache;
    }
    if (!record(parsed) || !record(parsed.entries)) {
      cache.dirty = true;
      return cache;
    }
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!hashPattern.test(key) || !validEntry(value) || cache.expired(value)) {
        cache.dirty = true;
        continue;
      }
      cache.entries.set(key, { ...value, answer: answerOnly(value.answer) });
      cache.accessClock = Math.max(cache.accessClock, value.lastUsedAt);
    }
    cache.trim();
    return cache;
  }

  private expired(entry: CacheEntry): boolean { return this.now() - entry.createdAt >= ttl; }

  private trim(): void {
    while (this.entries.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsedAt < oldestAt) { oldestKey = key; oldestAt = entry.lastUsedAt; }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.dirty = true;
    }
  }

  get(key: JevCacheKey): JevAnswer | undefined {
    const hash = jevCacheKey(key);
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (this.expired(entry) || (key.question && !answerMatchesQuestion(entry.answer, key.question))) {
      this.entries.delete(hash);
      this.dirty = true;
      return undefined;
    }
    entry.lastUsedAt = ++this.accessClock;
    this.dirty = true;
    return answerOnly(entry.answer);
  }

  set(key: JevCacheKey, answer: JevAnswer): void {
    if (!validAnswer(answer)) throw new TypeError('Invalid Jev answer');
    this.entries.set(jevCacheKey(key), { answer: answerOnly(answer), createdAt: this.now(), lastUsedAt: ++this.accessClock });
    this.dirty = true;
    this.trim();
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    for (const [key, entry] of this.entries) {
      if (this.expired(entry)) this.entries.delete(key);
    }
    this.trim();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ entries: Object.fromEntries(this.entries) }), { mode: 0o600 });
    await rename(temporary, this.file);
    this.dirty = false;
  }
}
