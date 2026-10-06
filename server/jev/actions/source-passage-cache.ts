import type { SourcePassage } from './source-passages.js';

type Entry = { passages: SourcePassage[]; bytes: number };
type CacheLimits = { maxBytes?: number; maxEntries?: number };

function validLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Passage cache limits must be nonnegative safe integers');
  return value;
}
function copied(passages: SourcePassage[]): SourcePassage[] {
  return passages.map(passage => ({ ...passage }));
}
function estimatedBytes(content: string, passages: SourcePassage[]): number {
  // Count retained UTF-16 strings independently, plus entry and passage objects,
  // their array slots, string references, and four numeric evidence offsets.
  return 128 + content.length * 2 + passages.reduce((bytes, passage) => bytes + 128 + (passage.quote.length + passage.text.length) * 2, 0);
}

/** Exact source keys, least-recently-used eviction, and independent caller evidence. */
export class SourcePassageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private bytes = 0;

  constructor(limits: CacheLimits = {}) {
    this.maxBytes = validLimit(limits.maxBytes ?? 32 * 1024 * 1024);
    this.maxEntries = validLimit(limits.maxEntries ?? 1024);
  }

  get(content: string): SourcePassage[] | undefined {
    const entry = this.entries.get(content);
    if (!entry) return undefined;
    this.entries.delete(content);
    this.entries.set(content, entry);
    return copied(entry.passages);
  }

  set(content: string, passages: SourcePassage[]): void {
    const bytes = estimatedBytes(content, passages);
    const previous = this.entries.get(content);
    if (previous) { this.entries.delete(content); this.bytes -= previous.bytes; }
    if (bytes > this.maxBytes || this.maxEntries === 0) return;
    while (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) this.evictOldest();
    this.entries.set(content, { passages: copied(passages), bytes });
    this.bytes += bytes;
  }

  private evictOldest(): void {
    // The incoming entry fits by itself and the entry limit is positive, so
    // exceeding either limit here requires an existing oldest entry.
    const key = this.entries.keys().next().value!;
    this.bytes -= this.entries.get(key)!.bytes;
    this.entries.delete(key);
  }
}
