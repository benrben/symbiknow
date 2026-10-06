import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { type JevWorkspaceState } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { atomicJson } from '../storage-files.js';
import { validId } from '../storage-shapes.js';
import { updatedJevSettings } from './configuration.js';
import { validateVocabularyMutation } from './vocabulary.js';
import { z } from 'zod';
import { automaticConfidenceThresholds, automaticModes, AUTOMATIC_POLICY_VERSION, migrateAutomaticWorkspace } from './automatic-policy.js';
import { createJevWorkspaceDecodePlan, encodeJevWorkspace, checkedJevWorkspaceValueReader } from './workspace-codec.js';
import { createHash } from 'node:crypto';
import type { StoredJevJob } from './runtime-queue.js';
import { WorkspacePacketCache } from './workspace-packet-cache.js';
import { workspaceReadPacket, type JevReadPacket } from './workspace-read-packet.js';
import { WorkspaceDecodeCache } from './workspace-decode-cache.js';
import { appendJournal, digest as contentDigest, journalRecord, readJournal, removeJournal,
  replayWorkspaceJournal } from './workspace-journal.js';

export function emptyJevWorkspace(): JevWorkspaceState {
  return { schemaVersion: 1, revision: 0, settings: { paused: false, externalProcessing: true,
    automaticPolicyVersion: AUTOMATIC_POLICY_VERSION, modes: automaticModes(), confidenceThresholds: automaticConfidenceThresholds(),
    people: [], schedules: [] }, jobs: [], proposals: [], receipts: [], vocabulary: [], profiles: {}, suppressions: [], prepared: [] };
}

const stateSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().safe().nonnegative(),
  settings: z.object({ modes: z.record(z.string(), z.enum(['off', 'shadow', 'suggest', 'auto'])),
    paused: z.boolean(), externalProcessing: z.boolean(), people: z.array(z.unknown()), schedules: z.array(z.unknown()) }).passthrough(),
  profiles: z.record(z.string(), z.record(z.string(), z.unknown())),
  jobs: z.array(z.unknown()), proposals: z.array(z.unknown()), receipts: z.array(z.unknown()), vocabulary: z.array(z.unknown()),
  suppressions: z.array(z.string()), prepared: z.array(z.unknown()) }).passthrough();
function stateShape(value: unknown): value is JevWorkspaceState { return stateSchema.safeParse(value).success; }
function decodeState(file: string, digest: string, content: string): JevWorkspaceState {
  let state: unknown;
  try { state = workspaceDecoders.read(file, digest, content, createJevWorkspaceDecodePlan); }
  catch { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
  if (!stateShape(state)) throw new ApiError(503, 'Symbi Reflex workspace state requires recovery');
  migrateAutomaticWorkspace(state);
  checkSettings(state); checkTerms(state);
  return state;
}
function checkSettings(state: JevWorkspaceState): void {
  try { updatedJevSettings(state.settings, {}); }
  catch { throw new ApiError(503, 'Symbi Reflex processing settings require recovery'); }
}
function checkTerms(state: JevWorkspaceState): void {
  try { for (const term of state.vocabulary) validateVocabularyMutation({ kind: 'vocabulary', operation: 'restore', term }); }
  catch { throw new ApiError(503, 'Symbi Reflex vocabulary requires recovery'); }
}
function checkPacketState(state: JevWorkspaceState): void {
  // Original state validation precedes this fixed projection; migration touches only the independent small snapshot.
  migrateAutomaticWorkspace(state); checkSettings(state); checkTerms(state);
}
function checkOriginalPacketState(encoded: unknown): void {
  const value = encoded as JevWorkspaceState & { state: JevWorkspaceState };
  const state = value.schemaVersion === 1 ? value : value.state;
  if (!stateShape(state)) throw new ApiError(503, 'Symbi Reflex workspace state requires recovery');
  checkSettings(state); checkTerms(state);
}
function checkedPacket(encoded: unknown): JevReadPacket {
  let read;
  try { read = checkedJevWorkspaceValueReader(encoded); }
  catch { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
  checkOriginalPacketState(encoded);
  return workspaceReadPacket(encoded, checkPacketState, read);
}
function decodePacket(content: string): JevReadPacket {
  let encoded: unknown;
  try { encoded = JSON.parse(content); }
  catch { throw new ApiError(503, 'Symbi Reflex workspace state requires recovery'); }
  return checkedPacket(encoded);
}
const workspaceQueues = new Map<string, Promise<unknown>>();
const readPackets = new WorkspacePacketCache<JevReadPacket>();
const workspaceDecoders = new WorkspaceDecodeCache();

/** Workspace state replacement is durable; canonical artifacts remain separate checked writes. */
export class JevWorkspaceFiles {
  private readonly snapshots = new WeakMap<JevWorkspaceState, { file: string; digest: string }>();
  constructor(private readonly root: string, private readonly options: {
    journalWrites?: boolean; journalCompactBytes?: number; journalCompactRecords?: number;
    onStorageWrite?: (kind: 'checkpoint' | 'journal', bytes: number) => void
  } = {}) {}

  file(workspaceId: string): string {
    if (!validId(workspaceId)) throw new ApiError(400, 'Invalid workspace ID');
    return path.join(this.root, 'jev', 'workspaces', workspaceId, 'state.json');
  }

  journalFile(workspaceId: string): string { return `${this.file(workspaceId)}.journal`; }

  private async contents(workspaceId: string): Promise<{ file: string; content?: Buffer; journal: Buffer; digest: string }> {
    const file = this.file(workspaceId);
    const [content, journal] = await Promise.all([
      readFile(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }), readJournal(this.journalFile(workspaceId)),
    ]);
    if (!content && journal.length) throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
    return { file, content, journal, digest: createHash('sha256').update(content ?? '').update(journal).digest('hex') };
  }

  private recovered(file: string, content: Buffer, journal: Buffer): { state: JevWorkspaceState;
    validBytes: number; records: number; lastHash: string; baseHash: string } {
    const baseHash = contentDigest(content);
    const base = decodeState(file, baseHash, content.toString('utf8'));
    const replay = replayWorkspaceJournal(base, baseHash, journal);
    if (!stateShape(replay.state)) throw new ApiError(503, 'Symbi Reflex workspace journal requires recovery');
    migrateAutomaticWorkspace(replay.state); checkSettings(replay.state); checkTerms(replay.state);
    return { ...replay, baseHash };
  }

  async read(workspaceId: string): Promise<JevWorkspaceState> {
    const { file, content, journal, digest } = await this.contents(workspaceId);
    if (!content) { workspaceDecoders.forget(file); return emptyJevWorkspace(); }
    const state = this.recovered(file, content, journal).state;
    this.snapshots.set(state, { file, digest });
    return state;
  }

  /** An uncommitted workspace-only transaction must not overwrite an externally replaced checkpoint. */
  async assertUnchanged(workspaceId: string, state: JevWorkspaceState): Promise<void> {
    const expected = this.snapshots.get(state);
    const file = this.file(workspaceId);
    if (!expected || expected.file !== file) throw new ApiError(409, 'The workspace checkpoint changed during completion');
    const current = await this.contents(workspaceId);
    if (!current.content || current.digest !== expected.digest)
      throw new ApiError(409, 'The workspace checkpoint changed during completion');
  }

  async write(workspaceId: string, state: JevWorkspaceState): Promise<void> {
    state.revision += 1;
    // Capture legacy checkpoint payload before the first await; callers may mutate their object while I/O is pending.
    const checkpoint = !this.options.journalWrites ? encodeJevWorkspace(state) : undefined;
    const { file, content, journal } = await this.contents(workspaceId);
    if (this.options.journalWrites && content) {
      const recovered = this.recovered(file, content, journal);
      if (state.revision !== recovered.state.revision + 1)
        throw new ApiError(409, 'The workspace checkpoint changed during completion');
      const entry = journalRecord(recovered.baseHash, recovered.lastHash, recovered.state, state);
      await appendJournal(this.journalFile(workspaceId), entry, recovered.validBytes, journal.length);
      this.options.onStorageWrite?.('journal', Buffer.byteLength(JSON.stringify(entry)) + 1);
      const compactBytes = this.options.journalCompactBytes ?? 96 * 1024;
      const compactRecords = this.options.journalCompactRecords ?? 32;
      if (recovered.validBytes + Buffer.byteLength(JSON.stringify(entry)) + 1 >= compactBytes
        || recovered.records + 1 >= compactRecords) {
        await atomicJson(file, encodeJevWorkspace(state), 0o600, 0,
          content => this.options.onStorageWrite?.('checkpoint', Buffer.byteLength(content)));
        await removeJournal(this.journalFile(workspaceId));
      }
    } else {
      await atomicJson(file, checkpoint ?? encodeJevWorkspace(state), 0o600, 0,
        content => this.options.onStorageWrite?.('checkpoint', Buffer.byteLength(content)));
      if (journal.length) await removeJournal(this.journalFile(workspaceId));
    }
    // Build the independent checked projection only when a reader requests this durable revision.
    readPackets.forget(file);
  }

  private async readPacket(workspaceId: string): Promise<JevReadPacket> {
    const { file, content, journal, digest } = await this.contents(workspaceId);
    if (!content) { readPackets.forget(file); return workspaceReadPacket(emptyJevWorkspace(), checkPacketState); }
    const cached = readPackets.get(file, digest);
    if (cached) return cached;
    const packet = journal.length
      ? workspaceReadPacket(this.recovered(file, content, journal).state, checkPacketState)
      : decodePacket(content.toString('utf8'));
    readPackets.set(file, digest, packet);
    return packet;
  }

  async readProgress(workspaceId: string): Promise<JevWorkspaceState | undefined> { return (await this.readPacket(workspaceId)).progress; }
  async readQueued(workspaceId: string): Promise<StoredJevJob[]> { return (await this.readPacket(workspaceId)).queuedJobs; }

  serial<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root) + ':' + workspaceId;
    const previous = workspaceQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    workspaceQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
