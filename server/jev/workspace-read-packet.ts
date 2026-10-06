import type { JevJson, JevMutation, JevReceipt, JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { publicJevJob, publicJevReceipt } from './authorization.js';
import { compactJevState, compactJob } from './compact-state.js';
import type { StoredJevJob } from './runtime-queue.js';
import { createDerivedValueReader, type DerivedValueReader, type WorkspaceDerivedValuePool } from './workspace-derived-value-pool.js';

export interface JevReadPacket { progress: JevWorkspaceState | undefined; queuedJobs: StoredJevJob[] }
type PacketInput = { progress: JevWorkspaceState; queuedJobs: StoredJevJob[] };
type EncodedWorkspace = { codec: 'jev-source-vectors'; version: number; state: JevWorkspaceState; sources: JevSourceSnapshot[];
  vectors: number[][]; references: Array<{ path: Array<string | number>; vector: number }> };
type VectorReader = (value: JevSourceSnapshot[], path: Array<string | number>) => JevSourceSnapshot[];
const publicFields = new Set(['schemaVersion', 'revision', 'settings', 'jobs', 'proposals', 'receipts', 'vocabulary',
  'profiles', 'suppressions', 'prepared', 'commandPlans', 'resetJournal']);

function vectorReader(encoded: EncodedWorkspace): VectorReader {
  const references = new Map(encoded.references.map(reference => [JSON.stringify(reference.path), reference.vector]));
  return (value, path) => {
    const vector = references.get(JSON.stringify(path));
    return vector === undefined ? value : encoded.vectors[vector].map(index => encoded.sources[index]);
  };
}
function queuedJob(job: StoredJevJob, sources: JevSourceSnapshot[]): StoredJevJob {
  const copy = { ...job, sources } as StoredJevJob & { followupSources?: JevSourceSnapshot[] };
  delete copy.result; delete copy.contextSources; delete copy.followupSources;
  return copy;
}
function progressMutation(mutation: JevMutation): JevMutation {
  if (mutation.kind === 'document') return { ...mutation, patch: {} };
  if (mutation.kind === 'content') return { ...mutation, content: '' };
  return mutation;
}
function progressReceipt(receipt: JevReceipt, sourcesAfter: JevSourceSnapshot[]): JevReceipt {
  const { id, proposalId, action, createdAt, actor, state, automatic } = receipt;
  return { id, proposalId, action, createdAt, actor, state, automatic, sourcesAfter,
    before: progressMutation(receipt.before), after: progressMutation(receipt.after) };
}
function visibleReceipt(receipt: JevReceipt, proposalIds: Set<string>): boolean {
  return proposalIds.has(receipt.proposalId) && ['document', 'content', 'move', 'vocabulary'].includes(receipt.after.kind);
}
function profilePassage(read: DerivedValueReader, key: string, value: JevJson): JevJson[] {
  const passages = read(['profiles', key, 'keyPassages'], value) as JevJson;
  return Array.isArray(passages) ? passages.slice(0, 1) : [];
}
function progressState(state: JevWorkspaceState, sources: VectorReader, read: DerivedValueReader): JevWorkspaceState {
  // Scope and migration filtering precede dropping proposals; orphaned or internal receipts never enter progress.
  const proposalIds = new Set(state.proposals.filter(proposal => !proposal.jobId.startsWith('origin-migration:')).map(proposal => proposal.id));
  const proposalIndex = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  const receipts = state.receipts.flatMap((receipt, index) => visibleReceipt(receipt, proposalIds)
    ? [progressReceipt(receipt, sources(receipt.sourcesAfter, ['receipts', index, 'sourcesAfter']))] : []);
  const profiles = Object.fromEntries(Object.entries(state.profiles)
    .filter(([, profile]) => !Array.isArray(profile.scopedCanvasIds) || profile.scopedCanvasIds.every(id => typeof id === 'string'))
    .map(([key, profile]) => [key, { role: profile.role, keyPassages: profilePassage(read, key, profile.keyPassages) }]));
  return { schemaVersion: state.schemaVersion, revision: state.revision, settings: { ...state.settings, schedules: [] },
    jobs: state.jobs.map(job => compactJob(job, proposalIndex)), profiles, proposals: [], receipts, vocabulary: state.vocabulary,
    suppressions: [], prepared: [], ...(state.commandPlans ? { commandPlans: state.commandPlans } : {}) };
}
function packetInput(state: JevWorkspaceState, sources: VectorReader, read: DerivedValueReader): PacketInput {
  const queuedJobs = state.jobs.flatMap((job, index) => job.state === 'queued'
    ? [queuedJob(job as StoredJevJob, sources(job.sources, ['jobs', index, 'sources']))] : []);
  return { progress: progressState(state, sources, read), queuedJobs };
}
function publicPacket(input: PacketInput): PacketInput {
  const queuedIds = new Set(input.progress.jobs.filter(job => job.state === 'queued').map(job => job.id));
  input.queuedJobs = input.queuedJobs.filter(job => queuedIds.has(job.id));
  input.progress.jobs = input.progress.jobs.map(publicJevJob);
  input.progress.receipts = input.progress.receipts.map(publicJevReceipt);
  input.progress = compactJevState(input.progress);
  return input;
}
function packetValueReader(state: JevWorkspaceState, value: Partial<EncodedWorkspace>, pooled: boolean): DerivedValueReader {
  return pooled && value.version === 3
    ? createDerivedValueReader(state, value as unknown as WorkspaceDerivedValuePool) : (_path, ordinaryValue) => ordinaryValue;
}
function packetSourceReader(encoded: Partial<EncodedWorkspace>, pooled: boolean): VectorReader {
  return pooled ? vectorReader(encoded as EncodedWorkspace) : source => source;
}

/** Snapshot only small packet inputs. A supplied reader belongs to this already-validated operation. */
export function workspaceReadPacket(value: unknown, validate: (state: JevWorkspaceState) => void,
  validatedRead?: DerivedValueReader): JevReadPacket {
  const encoded = value as Partial<EncodedWorkspace>;
  const pooled = encoded.codec === 'jev-source-vectors' && encoded.state !== undefined && (value as JevWorkspaceState).schemaVersion !== 1;
  const state = pooled ? encoded.state! : value as JevWorkspaceState;
  const sources = packetSourceReader(encoded, pooled);
  const read = validatedRead ?? packetValueReader(state, encoded, pooled);
  const packet = JSON.parse(JSON.stringify(packetInput(state, sources, read))) as PacketInput;
  validate(packet.progress);
  const result: JevReadPacket = publicPacket(packet);
  if (Object.keys(state).some(field => !publicFields.has(field))) result.progress = undefined;
  return result;
}
