type CacheOptions = { maxEntries?: number; maxBytes?: number };
type Entry<T> = { digest: string; packet: T; bytes: number };

function checkedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Cache limits must be nonnegative safe integers');
  return value;
}

/** Plain JSON projections are counted per reference, conservatively including aliased values. */
function retainedValueBytes(value: unknown): number {
  if (typeof value === 'string') return 64 + value.length * 2;
  if (Array.isArray(value)) return 64 + value.length * 16
    + value.reduce((bytes, item) => bytes + retainedValueBytes(item), 0);
  if (value !== null && typeof value === 'object') return 64 + Object.entries(value)
    .reduce((bytes, [key, item]) => bytes + 64 + key.length * 2 + retainedValueBytes(item), 0);
  return 16;
}

/** Retains independent, bounded workspace read projections; a changed digest always invalidates its older packet. */
export class WorkspacePacketCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor({ maxEntries = 64, maxBytes = 32 * 1024 * 1024 }: CacheOptions = {}) {
    this.maxEntries = checkedLimit(maxEntries);
    this.maxBytes = checkedLimit(maxBytes);
  }

  get(key: string, digest: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.digest !== digest) { this.forget(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.packet);
  }

  set(key: string, digest: string, packet: T): void {
    this.forget(key);
    const bytes = 256 + (key.length + digest.length) * 2 + retainedValueBytes(packet);
    if (this.maxEntries === 0 || bytes > this.maxBytes) return;
    const owned = structuredClone(packet);
    this.entries.set(key, { digest, packet: owned, bytes });
    this.bytes += bytes;
    this.evict();
  }

  forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.forget(this.entries.keys().next().value!);
    }
  }
}
