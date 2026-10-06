import { createHash } from 'node:crypto';
import { ApiError } from '../../errors.js';
import type { JevAnswer, JevCallOptions, JevDecider, JevQuestion } from '../../jev.js';
import { validateJevAnswers } from './context.js';

export interface QuestionAnswerCacheOptions { ttlMs?: number; maxEntries?: number; maxBytes?: number; now?: () => number }
type Entry = { serialized: string; expiresAt: number; bytes: number };
type Snapshot = { key: string; wire: string };
type Query = { state: unknown; questions: Record<string, JevQuestion> };
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Answer cache limits must be nonnegative safe integers');
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function snapshot(partition: string, apiKey: string, state: unknown, questions: Record<string, JevQuestion>): Snapshot {
  const wire = JSON.stringify({ state, questions });
  return { wire, key: hash(JSON.stringify([partition, hash(apiKey), wire])) };
}
function checkAbort(options?: JevCallOptions): void {
  if (options?.signal?.aborted) throw new ApiError(499, 'Symbi Reflex evaluation was cancelled');
}
function answers(serialized: string): Record<string, JevAnswer> { return JSON.parse(serialized) as Record<string, JevAnswer>; }

/** Exact, private typed answers may be reused briefly; every return owns its mutable values. */
export class QuestionAnswerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private bytes = 0;
  private epoch = 0;

  constructor({ ttlMs = 60_000, maxEntries = 2048, maxBytes = 8 * 1024 * 1024, now = Date.now }: QuestionAnswerCacheOptions = {}) {
    this.ttlMs = limit(ttlMs); this.maxEntries = limit(maxEntries); this.maxBytes = limit(maxBytes); this.now = now;
  }

  decider(partition: string, transport: JevDecider): JevDecider {
    return (apiKey, state, questions, fetcher, options) => this.decide(partition, transport, apiKey, state, questions, fetcher, options);
  }

  clear(): void { this.entries.clear(); this.bytes = 0; this.epoch += 1; }

  private async decide(partition: string, transport: JevDecider, apiKey: string, state: unknown,
    questions: Record<string, JevQuestion>, fetcher?: typeof fetch, options?: JevCallOptions): Promise<Record<string, JevAnswer>> {
    if (!Object.keys(questions).length) return transport(apiKey, state, questions, fetcher, options);
    checkAbort(options);
    const request = snapshot(partition, apiKey, state, questions); const cached = this.read(request.key);
    if (cached !== undefined) return answers(cached);
    const captured = JSON.parse(request.wire) as Query;
    const epoch = this.epoch;
    const result = await transport(apiKey, captured.state, captured.questions, fetcher, options);
    checkAbort(options);
    const serialized = JSON.stringify(result); const owned = answers(serialized);
    validateJevAnswers(owned, captured.questions);
    if (epoch === this.epoch) this.store(request.key, serialized);
    return owned;
  }

  private read(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.forget(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.serialized;
  }

  private store(key: string, serialized: string): void {
    // Strings may occupy two bytes per code unit; include entry and digest overhead conservatively.
    const bytes = 256 + (key.length + serialized.length) * 2;
    if (bytes > this.maxBytes) return;
    this.forget(key);
    this.entries.set(key, { serialized, expiresAt: this.now() + this.ttlMs, bytes }); this.bytes += bytes;
    this.evict();
  }

  private forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes; this.entries.delete(key);
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.forget(this.entries.keys().next().value!);
  }
}
