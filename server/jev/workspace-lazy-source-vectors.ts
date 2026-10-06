import type { JevSourceSnapshot } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';

export interface WorkspaceSourceVectorReference { path: readonly (string | number)[]; vector: number }
export interface UnreadWorkspaceSourceVector { readonly sourceTexts: readonly string[]; readonly indices: readonly number[] }
const sourceValues = new WeakMap<object, Map<string, LazySourceVector>>();
const descriptorFields = ['get', 'set', 'enumerable', 'configurable'] as const;

class LazySourceVector {
  private current: unknown;
  accessed = false;
  readonly getter = () => this.read();
  readonly setter = (value: unknown) => this.assign(value);
  constructor(private readonly owner: object, private readonly field: string, readonly plan: UnreadWorkspaceSourceVector) {}
  descriptor(): PropertyDescriptor { return { get: this.getter, set: this.setter, enumerable: true, configurable: true }; }
  matches(): boolean {
    const current = Object.getOwnPropertyDescriptor(this.owner, this.field) ?? {};
    const expected = this.descriptor();
    return descriptorFields.every(field => current[field] === expected[field]);
  }
  private expose(): void {
    if (!this.matches()) return;
    Object.defineProperty(this.owner, this.field, { value: this.current, writable: true, enumerable: true, configurable: true });
    sourceValues.get(this.owner)!.delete(this.field);
  }
  private read(): unknown {
    if (!this.accessed) { this.current = this.plan.indices.map(index => JSON.parse(this.plan.sourceTexts[index])); this.accessed = true; }
    this.expose(); return this.current;
  }
  private assign(value: unknown): void {
    if (Object.isFrozen(this.owner)) throw new TypeError(`Cannot assign to read only property '${this.field}'`);
    this.current = value; this.accessed = true; this.expose();
  }
}

function recovery(): never { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
function object(value: unknown): value is Record<string | number, unknown> { return value !== null && typeof value === 'object'; }
function ownChild(value: unknown, field: string | number): unknown {
  if (!object(value) || !Object.hasOwn(value, field)) recovery();
  return value[field];
}
function referenceOwner(state: unknown, path: readonly (string | number)[]): { owner: Record<string, unknown>; field: string } {
  let owner = state;
  for (const part of path.slice(0, -1)) owner = ownChild(owner, part);
  const field = path.at(-1);
  if (!object(owner) || typeof field !== 'string' || !Object.hasOwn(owner, field)) recovery();
  return { owner, field };
}
function install(owner: object, field: string, plan: UnreadWorkspaceSourceVector): void {
  const entry = new LazySourceVector(owner, field, plan);
  Object.defineProperty(owner, field, entry.descriptor());
  let fields = sourceValues.get(owner);
  if (!fields) { fields = new Map(); sourceValues.set(owner, fields); }
  fields.set(field, entry);
}

/** The caller validates external paths and indices before installing into its independently decoded state. */
export function createWorkspaceSourceVectorInstaller(sources: readonly JevSourceSnapshot[], vectors: readonly (readonly number[])[],
  references: readonly WorkspaceSourceVectorReference[]): <T>(state: T) => T {
  const sourceTexts = Object.freeze(sources.map(source => JSON.stringify(source)));
  const plans = vectors.map(indices => Object.freeze({ sourceTexts, indices: Object.freeze([...indices]) }));
  const retained = references.map(reference => ({ path: [...reference.path], plan: plans[reference.vector] }));
  return state => {
    for (const reference of retained) {
      const { owner, field } = referenceOwner(state, reference.path);
      if (!reference.plan) recovery();
      install(owner, field, reference.plan);
    }
    return state;
  };
}
export function installWorkspaceSourceVectors<T>(state: T, sources: readonly JevSourceSnapshot[], vectors: readonly (readonly number[])[],
  references: readonly WorkspaceSourceVectorReference[]): T {
  return createWorkspaceSourceVectorInstaller(sources, vectors, references)(state);
}

/** Only exact original unread descriptors may reuse immutable source evidence during encoding. */
export function unreadWorkspaceSourceVector(owner: object, field: string): UnreadWorkspaceSourceVector | undefined {
  const entry = sourceValues.get(owner)?.get(field);
  if (!entry || entry.accessed) return undefined;
  return entry.matches() ? entry.plan : undefined;
}
