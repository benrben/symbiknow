import { z } from 'zod';
import type { JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { artifactPoolFields, decodeWorkspaceArtifacts, encodeWorkspaceArtifacts, validateWorkspaceArtifacts,
  createWorkspaceArtifactDecoder } from './workspace-artifact-codec.js';
import { visitWorkspaceSourceReferences } from './workspace-source-reference-visitor.js';
import { derivedValuePoolFields, encodeWorkspaceDerivedValues, decodeWorkspaceDerivedValues,
  validateWorkspaceDerivedValues, copyWorkspaceDerivedValueOwner, createDerivedValueReader,
  type DerivedValueReader, createWorkspaceDerivedValueDecoder } from './workspace-derived-value-pool.js';
import { installWorkspaceSourceVectors, unreadWorkspaceSourceVector,
  type UnreadWorkspaceSourceVector, createWorkspaceSourceVectorInstaller } from './workspace-lazy-source-vectors.js';

type SourcePath = Array<string | number>;
type Mapper = (value: unknown, path: SourcePath, unread?: UnreadWorkspaceSourceVector) => unknown;
type Reference = { path: SourcePath; vector: number };
const sourceStrings = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'contentHash'] as const;
const sourceCounters = ['sourceGeneration', 'metadataRevision'] as const;
const nonnegative = z.number().int().safe().nonnegative();
const envelopeSchema = z.object({ codec: z.literal('jev-source-vectors'), version: z.literal(1),
  sources: z.array(z.unknown()), vectors: z.array(z.array(nonnegative)), state: z.unknown(),
  references: z.array(z.object({ path: z.array(z.union([z.string(), nonnegative])).min(1), vector: nonnegative }).strict()),
}).strict();
const artifactEnvelopeSchema = envelopeSchema.extend({ version: z.literal(2), ...artifactPoolFields }).strict();
// The derived helper validates every JSON value and its references. Avoid cloning that full history twice.
const derivedEnvelopeSchema = artifactEnvelopeSchema.extend({ version: z.literal(3), ...derivedValuePoolFields,
  derivedValues: z.array(z.unknown()) }).strict();
const workspaceEnvelopeSchema = z.discriminatedUnion('version', [envelopeSchema, artifactEnvelopeSchema, derivedEnvelopeSchema]);
type WorkspaceEnvelope = z.infer<typeof workspaceEnvelopeSchema> & { sources: JevSourceSnapshot[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function counter(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function sourceSnapshot(value: unknown): value is JevSourceSnapshot {
  if (!record(value) || Object.keys(value).length !== 7) return false;
  return sourceStrings.every(field => typeof value[field] === 'string') && sourceCounters.every(field => counter(value[field]));
}
function recovery(): never { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }

function mapFields(value: unknown, path: SourcePath, fields: Record<string, Mapper>): unknown {
  if (!record(value)) return value;
  const copy = copyWorkspaceDerivedValueOwner(value);
  for (const [field, mapper] of Object.entries(fields)) {
    if (!Object.hasOwn(value, field)) continue;
    const unread = unreadWorkspaceSourceVector(value, field);
    Object.defineProperty(copy, field, { value: mapper(unread ? [] : value[field], [...path, field], unread),
      enumerable: true, configurable: true, writable: true });
  }
  return copy;
}
function mapList(value: unknown, path: SourcePath, mapper: Mapper): unknown {
  return Array.isArray(value) ? value.map((item, index) => mapper(item, [...path, index])) : value;
}
function mapProfile(value: unknown, path: SourcePath, mapper: Mapper): unknown {
  return mapFields(value, path, { scopedSources: mapper });
}
function mapMutation(value: unknown, path: SourcePath, mapper: Mapper): unknown {
  if (!record(value) || value.kind !== 'derived') return value;
  return mapFields(value, path, { values: (values, location) => mapProfile(values, location, mapper) });
}
function mapProposal(value: unknown, path: SourcePath, mapper: Mapper): unknown {
  return mapFields(value, path, { sources: mapper, mutation: (mutation, location) => mapMutation(mutation, location, mapper) });
}
function mapProfiles(value: unknown, path: SourcePath, mapper: Mapper): unknown {
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, profile]) => [key, mapProfile(profile, [...path, key], mapper)]));
}

/** Only server-defined source-vector positions are encoded; native recovery proofs and arbitrary JSON stay intact. */
function mapWorkspace(value: unknown, mapper: Mapper): unknown {
  return mapFields(value, [], {
    jobs: (jobs, path) => mapList(jobs, path, (job, location) => mapFields(job, location,
      { sources: mapper, contextSources: mapper, followupSources: mapper })),
    proposals: (proposals, path) => mapList(proposals, path, (proposal, location) => mapProposal(proposal, location, mapper)),
    receipts: (receipts, path) => mapList(receipts, path, (receipt, location) => mapFields(receipt, location, {
      sourcesAfter: mapper, before: (before, point) => mapMutation(before, point, mapper), after: (after, point) => mapMutation(after, point, mapper),
    })),
    profiles: (profiles, path) => mapProfiles(profiles, path, mapper),
    prepared: (prepared, path) => mapList(prepared, path, (entry, location) => mapFields(entry, location, {
      proposal: (proposal, point) => mapProposal(proposal, point, mapper),
      before: (before, point) => mapMutation(before, point, mapper), after: (after, point) => mapMutation(after, point, mapper),
    })),
  });
}

class SourcePool {
  readonly sources: JevSourceSnapshot[] = [];
  readonly vectors: number[][] = [];
  readonly references: Reference[] = [];
  private readonly sourceIds = new Map<string, number>();
  private readonly vectorIds = new Map<string, number>();
  private readonly unreadVectorIds = new WeakMap<readonly number[], number>();

  private sourceId(source: JevSourceSnapshot): number {
    return this.sourceTextId(JSON.stringify(source), source);
  }
  private sourceTextId(key: string, source?: JevSourceSnapshot): number {
    const prior = this.sourceIds.get(key);
    if (prior !== undefined) return prior;
    const id = this.sources.length; this.sourceIds.set(key, id); this.sources.push(source ?? JSON.parse(key) as JevSourceSnapshot);
    return id;
  }
  private unreadVector(plan: UnreadWorkspaceSourceVector): number {
    const prior = this.unreadVectorIds.get(plan.indices);
    if (prior !== undefined) return prior;
    const ids = plan.indices.map(index => this.sourceTextId(plan.sourceTexts[index]));
    const key = JSON.stringify(ids); let id = this.vectorIds.get(key);
    if (id === undefined) { id = this.vectors.length; this.vectorIds.set(key, id); this.vectors.push(ids); }
    this.unreadVectorIds.set(plan.indices, id);
    return id;
  }
  private ordinaryVector(value: unknown): number | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const key = JSON.stringify(value); let id = this.vectorIds.get(key);
    if (id === undefined) {
      if (!value.every(sourceSnapshot)) return undefined;
      const ids = value.map(source => this.sourceId(source)); const normalizedKey = JSON.stringify(ids);
      id = this.vectorIds.get(normalizedKey);
      if (id === undefined) { id = this.vectors.length; this.vectorIds.set(normalizedKey, id); this.vectors.push(ids); }
      this.vectorIds.set(key, id);
    }
    return id;
  }
  encode(value: unknown, path: SourcePath, unread?: UnreadWorkspaceSourceVector): unknown {
    const id = unread ? this.unreadVector(unread) : this.ordinaryVector(value);
    if (id === undefined) return value;
    this.references.push({ path, vector: id });
    return [];
  }
}

export function encodeJevWorkspace(state: JevWorkspaceState): unknown {
  const pool = new SourcePool(); const encoded = mapWorkspace(state, (value, path, unread) => pool.encode(value, path, unread));
  const derived = encodeWorkspaceDerivedValues(encoded);
  const artifacts = encodeWorkspaceArtifacts(derived.state);
  if (derived.derivedValueReferences.length) return { codec: 'jev-source-vectors', version: 3, sources: pool.sources,
    vectors: pool.vectors, references: pool.references, ...artifacts,
    derivedValues: derived.derivedValues, derivedValueReferences: derived.derivedValueReferences };
  if (artifacts.blockReferences.length) return { codec: 'jev-source-vectors', version: 2, sources: pool.sources,
    vectors: pool.vectors, references: pool.references, ...artifacts };
  if (pool.references.length === 0) return state;
  return { codec: 'jev-source-vectors', version: 1, sources: pool.sources, vectors: pool.vectors, references: pool.references, state: encoded };
}

function checkedEnvelope(value: unknown): WorkspaceEnvelope {
  const parsed = workspaceEnvelopeSchema.safeParse(value);
  if (!parsed.success) return recovery();
  const envelope = parsed.data;
  if (!envelope.sources.every(sourceSnapshot)) return recovery();
  if (envelope.vectors.some(vector => vector.some(id => id >= envelope.sources.length))) return recovery();
  return envelope as WorkspaceEnvelope;
}
function referenceMap(envelope: WorkspaceEnvelope): Map<string, number> {
  const references = new Map<string, number>();
  for (const reference of envelope.references) {
    const key = JSON.stringify(reference.path);
    if (references.has(key) || reference.vector >= envelope.vectors.length) recovery();
    references.set(key, reference.vector);
  }
  return references;
}

function checkedSourceReferences(envelope: WorkspaceEnvelope): Map<string, number> {
  const references = referenceMap(envelope); const restored = new Set<string>();
  visitWorkspaceSourceReferences(envelope.state, (item, path) => {
    const key = JSON.stringify(path); const vector = references.get(key);
    if (vector === undefined) return;
    if (!Array.isArray(item) || item.length !== 0) recovery();
    restored.add(key);
  });
  if (restored.size !== references.size) recovery();
  return references;
}

function checkedWorkspacePools(value: unknown): WorkspaceEnvelope | undefined {
  if (record(value) && value.schemaVersion === 1) return undefined;
  const envelope = checkedEnvelope(value); checkedSourceReferences(envelope);
  if (envelope.version !== 1) validateWorkspaceArtifacts(envelope.state, envelope);
  return envelope;
}

/** Check pooled snapshots and reference tables without allocating hydrated history. */
export function validateJevWorkspacePool(value: unknown): void {
  const envelope = checkedWorkspacePools(value);
  if (!envelope) return;
  if (envelope.version === 3) validateWorkspaceDerivedValues(envelope.state, envelope);
}

/** One checked read plan per packet operation; direct packet callers retain their own validation. */
export function checkedJevWorkspaceValueReader(value: unknown): DerivedValueReader {
  const envelope = checkedWorkspacePools(value);
  return envelope?.version === 3 ? createDerivedValueReader(envelope.state, envelope)
    : (_path, ordinaryValue) => ordinaryValue;
}

export function decodeJevWorkspace(value: unknown): unknown {
  // Legacy schemaVersion:1 JSON remains authoritative, including arbitrary future fields named "codec".
  if (record(value) && value.schemaVersion === 1) return value;
  const envelope = checkedEnvelope(value); checkedSourceReferences(envelope);
  const decoded = mapWorkspace(envelope.state, item => item);
  const restored = envelope.version === 1 ? decoded : decodeWorkspaceArtifacts(decoded, envelope);
  const derived = envelope.version === 3 ? decodeWorkspaceDerivedValues(restored, envelope) : restored;
  return installWorkspaceSourceVectors(derived, envelope.sources, envelope.vectors, envelope.references);
}

/** Capture checked JSON bytes privately. Repeated reads share immutable plans, never mutable state or hydrated values. */
export function createJevWorkspaceDecodePlan(content: string): () => unknown {
  const value: unknown = JSON.parse(content);
  if (record(value) && value.schemaVersion === 1) return () => JSON.parse(content);
  const envelope = checkedEnvelope(value); checkedSourceReferences(envelope);
  const artifacts = envelope.version === 1 ? (state: unknown) => state : createWorkspaceArtifactDecoder(envelope.state, envelope);
  const derived = envelope.version === 3 ? createWorkspaceDerivedValueDecoder(envelope.state, envelope) : (state: unknown) => state;
  const sources = createWorkspaceSourceVectorInstaller(envelope.sources, envelope.vectors, envelope.references);
  const stateText = JSON.stringify(envelope.state);
  return () => sources(derived(artifacts(JSON.parse(stateText))));
}
