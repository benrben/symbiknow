import { z } from 'zod';
import { ApiError } from '../errors.js';

type SourcePath = Array<string | number>;
type BlockPlan = { text: readonly string[]; indices: readonly number[] };
type BlockMapper = (blocks: unknown[], path: SourcePath, unread?: BlockPlan) => unknown[] | BlockPlan;
type Reference = { path: SourcePath; vector: number };
export interface WorkspaceArtifactPool { blocks: unknown[]; blockVectors: number[][]; blockReferences: Reference[] }
const nonnegative = z.number().int().safe().nonnegative();
const canvasFields = ['before', 'after', 'reserved'] as const;
const canvasStrings = ['id', 'name', 'workspaceId'] as const;
const referencePath = z.union([
  z.tuple([z.literal('receipts'), nonnegative, z.literal('preparedArtifacts'), nonnegative, z.enum(canvasFields), z.literal('blocks')]),
  z.tuple([z.literal('prepared'), nonnegative, z.literal('artifacts'), nonnegative, z.enum(canvasFields), z.literal('blocks')]),
]);
export const artifactPoolFields = { blocks: z.array(z.unknown()), blockVectors: z.array(z.array(nonnegative)),
  blockReferences: z.array(z.object({ path: referencePath, vector: nonnegative }).strict()) };
const lazyBlocks = new WeakMap<object, LazyCanvasBlocks>();
const descriptorFields = ['get', 'set', 'enumerable', 'configurable'] as const;

class LazyCanvasBlocks implements BlockPlan {
  private current: unknown;
  accessed = false;
  readonly getter = () => this.read();
  readonly setter = (value: unknown) => this.assign(value);

  constructor(private readonly canvas: object, readonly text: readonly string[], readonly indices: readonly number[]) {}
  descriptor(): PropertyDescriptor { return { get: this.getter, set: this.setter, enumerable: true, configurable: true }; }
  matches(): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(this.canvas, 'blocks') ?? {};
    const expected = this.descriptor();
    return descriptorFields.every(field => descriptor[field] === expected[field]);
  }
  private expose(): void {
    if (!this.matches()) return;
    Object.defineProperty(this.canvas, 'blocks', { value: this.current, enumerable: true, configurable: true, writable: true });
    lazyBlocks.delete(this.canvas);
  }
  private read(): unknown {
    if (!this.accessed) { this.current = this.indices.map(index => JSON.parse(this.text[index])); this.accessed = true; }
    this.expose(); return this.current;
  }
  private assign(value: unknown): void {
    if (Object.isFrozen(this.canvas)) throw new TypeError("Cannot assign to read only property 'blocks'");
    this.current = value; this.accessed = true; this.expose();
  }
}
function unreadBlocks(canvas: object): BlockPlan | undefined {
  const entry = lazyBlocks.get(canvas);
  if (!entry || entry.accessed) return undefined;
  return entry.matches() ? entry : undefined;
}
function installLazyBlocks(canvas: object, plan: BlockPlan): void {
  const entry = new LazyCanvasBlocks(canvas, plan.text, plan.indices);
  Object.defineProperty(canvas, 'blocks', entry.descriptor()); lazyBlocks.set(canvas, entry);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function canvasSnapshot(value: unknown): value is Record<string, unknown> & { blocks: unknown[] } {
  if (!record(value) || Object.keys(value).length !== 4) return false;
  return canvasStrings.every(field => typeof value[field] === 'string') && (unreadBlocks(value) !== undefined || Array.isArray(value.blocks));
}
function blockSnapshot(value: unknown): boolean {
  return record(value) && typeof value.id === 'string' && typeof value.file === 'string';
}
function recovery(): never { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
function emptyBlocks(blocks: unknown[], unread?: BlockPlan): boolean {
  return blocks.length === 0 && (unread?.indices.length ?? 0) === 0;
}
function mapCanvas(value: unknown, path: SourcePath, mapper: BlockMapper): unknown {
  if (!canvasSnapshot(value)) return value;
  const unread = unreadBlocks(value); const replacement = mapper(unread ? [] : value.blocks, [...path, 'blocks'], unread);
  // Copying blocks with a spread would invoke its getter and eagerly restore all history.
  const copy = Object.fromEntries(Object.keys(value).map(field => [field, field === 'blocks' ? [] : value[field]]));
  if (Array.isArray(replacement)) copy.blocks = replacement;
  else installLazyBlocks(copy, replacement);
  return copy;
}
function mapArtifact(value: unknown, path: SourcePath, mapper: BlockMapper): unknown {
  if (!record(value) || value.kind !== 'canvas' || typeof value.id !== 'string') return value;
  const copy = { ...value };
  for (const field of canvasFields) {
    if (Object.hasOwn(value, field)) copy[field] = mapCanvas(value[field], [...path, field], mapper);
  }
  return copy;
}
function mapEntry(value: unknown, path: SourcePath, field: string, mapper: BlockMapper): unknown {
  if (!record(value) || !Array.isArray(value[field])) return value;
  return { ...value, [field]: value[field].map((item, index) => mapArtifact(item, [...path, field, index], mapper)) };
}
function mapWorkspaceArtifacts(value: unknown, mapper: BlockMapper): unknown {
  if (!record(value)) return value;
  const copy = { ...value };
  for (const [field, artifacts] of [['receipts', 'preparedArtifacts'], ['prepared', 'artifacts']]) {
    if (Array.isArray(value[field])) copy[field] = value[field].map((entry, index) => mapEntry(entry, [field, index], artifacts, mapper));
  }
  return copy;
}

class ArtifactPool implements WorkspaceArtifactPool {
  readonly blocks: unknown[] = [];
  readonly blockVectors: number[][] = [];
  readonly blockReferences: Reference[] = [];
  private readonly blockIds = new Map<string, number>();
  private readonly vectorIds = new Map<string, number>();
  private readonly unreadVectorIds = new WeakMap<readonly number[], number>();

  private blockId(key: string, block?: unknown): number {
    const prior = this.blockIds.get(key);
    if (prior !== undefined) return prior;
    const id = this.blocks.length; this.blocks.push(block ?? JSON.parse(key)); this.blockIds.set(key, id);
    return id;
  }
  private vectorId(ids: number[]): number {
    const key = JSON.stringify(ids);
    let vector = this.vectorIds.get(key);
    if (vector === undefined) { vector = this.blockVectors.length; this.blockVectors.push(ids); this.vectorIds.set(key, vector); }
    return vector;
  }
  private unreadVector(unread: BlockPlan): number {
    const prior = this.unreadVectorIds.get(unread.indices);
    if (prior !== undefined) return prior;
    const vector = this.vectorId(unread.indices.map(index => this.blockId(unread.text[index])));
    this.unreadVectorIds.set(unread.indices, vector);
    return vector;
  }
  encode(blocks: unknown[], path: SourcePath, unread?: BlockPlan): unknown[] {
    if (!unread && (!blocks.length || !blocks.every(blockSnapshot))) return blocks;
    const vector = unread ? this.unreadVector(unread) : this.vectorId(blocks.map(block => this.blockId(JSON.stringify(block), block)));
    this.blockReferences.push({ path, vector });
    return [];
  }
}

/** Native proofs are pooled only inside checked receipt/prepared canvas artifact locations. */
export function encodeWorkspaceArtifacts(state: unknown): WorkspaceArtifactPool & { state: unknown } {
  const pool = new ArtifactPool(); const encoded = mapWorkspaceArtifacts(state, (blocks, path, unread) => pool.encode(blocks, path, unread));
  return { blocks: pool.blocks, blockVectors: pool.blockVectors, blockReferences: pool.blockReferences, state: encoded };
}
function referenceMap(pool: WorkspaceArtifactPool): Map<string, number> {
  const references = new Map<string, number>();
  for (const reference of pool.blockReferences) {
    const key = JSON.stringify(reference.path);
    if (references.has(key) || reference.vector >= pool.blockVectors.length) recovery();
    references.set(key, reference.vector);
  }
  return references;
}
function checkedReferences(state: unknown, pool: WorkspaceArtifactPool): Map<string, number> {
  if (!pool.blocks.every(blockSnapshot)) recovery();
  if (pool.blockVectors.some(vector => vector.some(index => index >= pool.blocks.length))) recovery();
  const references = referenceMap(pool); const restored = new Set<string>();
  mapWorkspaceArtifacts(state, (blocks, path, unread) => {
    const key = JSON.stringify(path);
    if (!references.has(key)) return unread ?? blocks;
    if (!emptyBlocks(blocks, unread)) recovery();
    restored.add(key); return blocks;
  });
  if (restored.size !== references.size) recovery();
  return references;
}

export function validateWorkspaceArtifacts(state: unknown, pool: WorkspaceArtifactPool): void { checkedReferences(state, pool); }
/** A checked private dictionary plan restores independent owners without revalidating its immutable proof texts. */
export function createWorkspaceArtifactDecoder(state: unknown, pool: WorkspaceArtifactPool): (state: unknown) => unknown {
  const references = checkedReferences(state, pool); const text = Object.freeze(pool.blocks.map(block => JSON.stringify(block)));
  const vectors = pool.blockVectors.map(vector => Object.freeze([...vector]));
  return value => mapWorkspaceArtifacts(value, (blocks, path, unread) => {
    const vector = references.get(JSON.stringify(path));
    return vector === undefined ? unread ?? blocks : { text, indices: vectors[vector] };
  });
}
export function decodeWorkspaceArtifacts(state: unknown, pool: WorkspaceArtifactPool): unknown {
  return createWorkspaceArtifactDecoder(state, pool)(state);
}
