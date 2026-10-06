type DecodePlan = () => unknown;
type PreparePlan = (content: string) => DecodePlan;
type Entry = { digest: string; decode: DecodePlan; bytes: number };

function checkedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Cache limits must be nonnegative safe integers');
  return value;
}

/** Plans own immutable JSON texts, never caller snapshots. Each use creates new mutable lazy owners. */
export class WorkspaceDecodeCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor({ maxEntries = 16, maxBytes = 128 * 1024 * 1024 } = {}) {
    this.maxEntries = checkedLimit(maxEntries); this.maxBytes = checkedLimit(maxBytes);
  }

  read(key: string, digest: string, content: string, prepare: PreparePlan): unknown {
    const prior = this.entries.get(key);
    if (prior?.digest === digest) {
      this.entries.delete(key); this.entries.set(key, prior);
      return prior.decode();
    }
    this.forget(key);
    const decode = prepare(content);
    // Account conservatively for UTF-16 state/dictionary texts, retained indices and reference maps.
    const bytes = 1024 + (key.length + digest.length) * 2 + Buffer.byteLength(content) * 4;
    if (this.maxEntries > 0 && bytes <= this.maxBytes) {
      this.entries.set(key, { digest, decode, bytes }); this.bytes += bytes; this.evict();
    }
    return decode();
  }

  forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.bytes -= entry.bytes;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.forget(this.entries.keys().next().value!);
  }
}
