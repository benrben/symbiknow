import { z } from 'zod';
import { ApiError } from '../errors.js';

type Path = Array<string | number>;
type Reference = { path: Path; value: number };
type Replacement = { value: unknown } | { text: string };
type Mapper = (value: unknown, path: Path, unread?: LazyDerivedValue) => Replacement;
export interface WorkspaceDerivedValuePool { derivedValues: unknown[]; derivedValueReferences: Reference[] }
export type DerivedValueReader = (path: Path, ordinaryValue: unknown) => unknown;
const fields = ['recall', 'linkRechecks', 'qualityRubric', 'keyPassages'] as const;
const fieldSchema = z.enum(fields);
const index = z.number().int().safe().nonnegative();
const pathSchema = z.union([
  z.tuple([z.literal('proposals'), index, z.literal('mutation'), z.literal('values'), fieldSchema]),
  z.tuple([z.literal('receipts'), index, z.enum(['before', 'after']), z.literal('values'), fieldSchema]),
  z.tuple([z.literal('prepared'), index, z.literal('proposal'), z.literal('mutation'), z.literal('values'), fieldSchema]),
  z.tuple([z.literal('prepared'), index, z.enum(['before', 'after']), z.literal('values'), fieldSchema]),
  z.tuple([z.literal('profiles'), z.string(), fieldSchema]),
]);
export const derivedValuePoolFields = { derivedValues: z.array(z.json()),
  derivedValueReferences: z.array(z.object({ path: pathSchema, value: index }).strict()) };
const poolSchema = z.object(derivedValuePoolFields);
const lazyValues = new WeakMap<object, Map<string, LazyDerivedValue>>();
const descriptorFields = ['get', 'set', 'enumerable', 'configurable'] as const;
function recovery(): never { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class LazyDerivedValue {
  private current: unknown;
  accessed = false;
  readonly getter = () => this.read();
  readonly setter = (value: unknown) => this.assign(value);
  constructor(private readonly owner: object, private readonly field: string, readonly text: string) {}
  descriptor(): PropertyDescriptor { return { get: this.getter, set: this.setter, enumerable: true, configurable: true }; }
  matches(): boolean {
    const current = Object.getOwnPropertyDescriptor(this.owner, this.field) ?? {};
    const expected = this.descriptor();
    return descriptorFields.every(field => current[field] === expected[field]);
  }
  private expose(): void {
    if (!this.matches()) return;
    Object.defineProperty(this.owner, this.field, { value: this.current, writable: true, enumerable: true, configurable: true });
    lazyValues.get(this.owner)!.delete(this.field);
  }
  private read(): unknown {
    if (!this.accessed) { this.current = JSON.parse(this.text); this.accessed = true; }
    this.expose(); return this.current;
  }
  private assign(value: unknown): void {
    if (Object.isFrozen(this.owner)) throw new TypeError(`Cannot assign to read only property '${this.field}'`);
    this.current = value; this.accessed = true; this.expose();
  }
}
function unreadValue(owner: object, field: string): LazyDerivedValue | undefined {
  const entry = lazyValues.get(owner)?.get(field);
  if (!entry || entry.accessed) return undefined;
  return entry.matches() ? entry : undefined;
}
function install(owner: object, field: string, text: string): void {
  const entry = new LazyDerivedValue(owner, field, text);
  Object.defineProperty(owner, field, entry.descriptor());
  let values = lazyValues.get(owner);
  if (!values) { values = new Map(); lazyValues.set(owner, values); }
  values.set(field, entry);
}
/** Copy containers without reading foreign lazy slots; preserve ownership of our unread derived values. */
export function copyWorkspaceDerivedValueOwner(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const field of Object.keys(value)) {
    const unread = unreadValue(value, field);
    if (unread) { install(copy, field, unread.text); continue; }
    const descriptor = Object.getOwnPropertyDescriptor(value, field)!;
    Object.defineProperty(copy, field, { ...descriptor, configurable: true, ...('value' in descriptor ? { writable: true } : {}) });
  }
  return copy;
}
function unchanged(value: unknown, unread?: LazyDerivedValue): Replacement {
  return unread ? { text: unread.text } : { value };
}
function mapValues(value: unknown, path: Path, mapper: Mapper): unknown {
  if (!record(value)) return value;
  // Read only ordinary fields. Our private getters retain untouched historical JSON without hydration.
  const keys = Object.keys(value);
  const copy = Object.fromEntries(keys.map(field => [field, unreadValue(value, field) ? null : value[field]]));
  for (const field of fields) {
    if (!keys.includes(field)) continue;
    const unread = unreadValue(value, field);
    const next = mapper(unread ? null : value[field], [...path, field], unread);
    if ('text' in next) install(copy, field, next.text);
    else copy[field] = next.value;
  }
  return copy;
}
type Visitor = (value: unknown, path: Path, unread?: LazyDerivedValue) => void;
function visitField(value: unknown, path: Path, name: string, visitor: (value: unknown, path: Path) => void): void {
  if (record(value) && Object.hasOwn(value, name)) visitor(value[name], [...path, name]);
}
function visitList(value: unknown, path: Path, visitor: (value: unknown, path: Path) => void): void {
  if (Array.isArray(value)) value.forEach((item, at) => visitor(item, [...path, at]));
}
function visitValues(value: unknown, path: Path, visitor: Visitor): void {
  if (!record(value)) return;
  for (const field of fields) {
    if (!Object.prototype.propertyIsEnumerable.call(value, field)) continue;
    const unread = unreadValue(value, field); visitor(unread ? null : value[field], [...path, field], unread);
  }
}
function visitMutation(value: unknown, path: Path, visitor: Visitor): void {
  if (!record(value) || value.kind !== 'derived') return;
  visitField(value, path, 'values', (values, point) => visitValues(values, point, visitor));
}
function visitProposal(value: unknown, path: Path, visitor: Visitor): void {
  visitField(value, path, 'mutation', (mutation, point) => visitMutation(mutation, point, visitor));
}
function visitHistory(value: unknown, path: Path, visitor: Visitor): void {
  for (const field of ['before', 'after']) visitField(value, path, field, (mutation, point) => visitMutation(mutation, point, visitor));
}
function visitWorkspace(value: unknown, visitor: Visitor): void {
  visitField(value, [], 'proposals', (items, path) => visitList(items, path, (item, point) => visitProposal(item, point, visitor)));
  visitField(value, [], 'receipts', (items, path) => visitList(items, path, (item, point) => visitHistory(item, point, visitor)));
  visitField(value, [], 'prepared', (items, path) => visitList(items, path, (item, point) => {
    visitHistory(item, point, visitor); visitField(item, point, 'proposal', (proposal, location) => visitProposal(proposal, location, visitor));
  }));
  visitField(value, [], 'profiles', (items, path) => {
    if (record(items)) for (const [key, profile] of Object.entries(items)) visitValues(profile, [...path, key], visitor);
  });
}
function mapFields(value: unknown, path: Path, mappers: Record<string, (value: unknown, path: Path) => unknown>): unknown {
  if (!record(value)) return value;
  const copy = { ...value };
  for (const [field, mapper] of Object.entries(mappers)) if (Object.hasOwn(value, field)) copy[field] = mapper(value[field], [...path, field]);
  return copy;
}
function mapList(value: unknown, path: Path, mapper: (value: unknown, path: Path) => unknown): unknown {
  return Array.isArray(value) ? value.map((item, at) => mapper(item, [...path, at])) : value;
}
function mapMutation(value: unknown, path: Path, mapper: Mapper): unknown {
  if (!record(value) || value.kind !== 'derived') return value;
  return mapFields(value, path, { values: (values, point) => mapValues(values, point, mapper) });
}
function mapProposal(value: unknown, path: Path, mapper: Mapper): unknown {
  return mapFields(value, path, { mutation: (mutation, point) => mapMutation(mutation, point, mapper) });
}
function mapWorkspace(value: unknown, mapper: Mapper): unknown {
  const mutations = (entry: unknown, path: Path) => mapFields(entry, path, {
    before: (item, point) => mapMutation(item, point, mapper), after: (item, point) => mapMutation(item, point, mapper),
  });
  return mapFields(value, [], {
    proposals: (items, path) => mapList(items, path, (item, point) => mapProposal(item, point, mapper)),
    receipts: (items, path) => mapList(items, path, mutations),
    prepared: (items, path) => mapList(items, path, (item, point) => mapFields(mutations(item, point), point,
      { proposal: (proposal, location) => mapProposal(proposal, location, mapper) })),
    profiles: (items, path) => record(items) ? Object.fromEntries(Object.entries(items)
      .map(([key, profile]) => [key, mapValues(profile, [...path, key], mapper)])) : items,
  });
}

/** Pool only repeated exact bodies at server-defined derived slots; source vectors and native proofs stay untouched. */
export function encodeWorkspaceDerivedValues(state: unknown): WorkspaceDerivedValuePool & { state: unknown } {
  type Entry = { text: string; count: number; index?: number };
  const entries = new Map<string, Entry>(); const paths = new Map<string, Entry>();
  visitWorkspace(state, (value, path, unread) => {
    const text = unread?.text ?? JSON.stringify(value);
    if (typeof text !== 'string' || text.length < 128) return;
    let entry = entries.get(text);
    if (!entry) { entry = { text, count: 0 }; entries.set(text, entry); }
    entry.count++; paths.set(JSON.stringify(path), entry);
  });
  const derivedValues: unknown[] = []; const derivedValueReferences: Reference[] = [];
  const encoded = mapWorkspace(state, (value, path, unread) => {
    const entry = paths.get(JSON.stringify(path));
    if (!entry || entry.count < 2) return unchanged(value, unread);
    if (entry.index === undefined) { entry.index = derivedValues.length; derivedValues.push(JSON.parse(entry.text)); }
    derivedValueReferences.push({ path, value: entry.index });
    return { value: null };
  });
  return { state: encoded, derivedValues, derivedValueReferences };
}
function checkedPool(pool: WorkspaceDerivedValuePool): WorkspaceDerivedValuePool {
  try {
    const parsed = poolSchema.safeParse(pool);
    return parsed.success ? parsed.data : recovery();
  } catch { return recovery(); }
}
function checkedReferences(state: unknown, pool: WorkspaceDerivedValuePool): Map<string, number> {
  const references = new Map<string, number>();
  for (const reference of pool.derivedValueReferences) {
    const path = JSON.stringify(reference.path);
    if (references.has(path) || reference.value >= pool.derivedValues.length) recovery();
    references.set(path, reference.value);
  }
  const found = new Set<string>();
  visitWorkspace(state, (value, path, unread) => {
    const key = JSON.stringify(path);
    if (!references.has(key)) return;
    if (unread || value !== null) recovery();
    found.add(key);
  });
  if (found.size !== references.size) recovery();
  return references;
}
export function validateWorkspaceDerivedValues(state: unknown, pool: WorkspaceDerivedValuePool): void {
  checkedReferences(state, checkedPool(pool));
}
export function createDerivedValueReader(state: unknown, pool: WorkspaceDerivedValuePool): DerivedValueReader {
  const checked = checkedPool(pool); const references = checkedReferences(state, checked);
  const text = checked.derivedValues.map(value => JSON.stringify(value));
  return (path, ordinaryValue) => {
    const index = references.get(JSON.stringify(path));
    return index === undefined ? ordinaryValue : JSON.parse(text[index]);
  };
}
export function readDerivedValue(state: unknown, pool: WorkspaceDerivedValuePool, path: Path, ordinaryValue?: unknown): unknown {
  let value = state;
  for (const field of path) {
    if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, field)) return createDerivedValueReader(state, pool)(path, ordinaryValue);
    value = (value as Record<string | number, unknown>)[field];
  }
  return createDerivedValueReader(state, pool)(path, value);
}
/** Reuse only private checked JSON texts; each restoration installs new independently mutable value owners. */
export function createWorkspaceDerivedValueDecoder(state: unknown, pool: WorkspaceDerivedValuePool): (state: unknown) => unknown {
  const checked = checkedPool(pool); const references = checkedReferences(state, checked);
  const text = checked.derivedValues.map(value => JSON.stringify(value));
  return decoded => mapWorkspace(decoded, (value, path, unread) => {
    const index = references.get(JSON.stringify(path));
    return index === undefined ? unchanged(value, unread) : { text: text[index] };
  });
}
export function decodeWorkspaceDerivedValues(state: unknown, pool: WorkspaceDerivedValuePool): unknown {
  return createWorkspaceDerivedValueDecoder(state, pool)(state);
}
