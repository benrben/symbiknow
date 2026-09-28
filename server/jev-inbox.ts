import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InsightItem } from '../shared/insights.js';
import { applyInsightAction } from './automation.js';
import { analyzeCanvas } from './insights.js';
import { ApiError, type CanvasStore } from './storage.js';
import { decideWithJev, type JevDecider } from './jev.js';

type SavedFinding = { item: InsightItem; sourceHashes: Record<string, string> };
type Review = { hash: string; checkedAt: string; findings: SavedFinding[]; dismissed: string[] };
type InboxState = { reviews: Record<string, Review>; errors?: Record<string, { hash: string; message: string }> };
export type InboxResponse = { canvasId: string; items: InsightItem[]; checkedBlockIds: string[];
  pendingBlockIds: string[]; errors: { blockId: string; message: string }[] };

const inFlight = new Map<string, Promise<InboxResponse>>();
const maxChecksPerBatch = 2;

function fileFor(store: CanvasStore, canvasId: string): string {
  return path.join(store.root, 'jev-inbox', `${canvasId}.json`);
}

async function load(store: CanvasStore, canvasId: string): Promise<InboxState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(fileFor(store, canvasId), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'reviews' in parsed
      && parsed.reviews && typeof parsed.reviews === 'object' && !Array.isArray(parsed.reviews)) {
      return parsed as InboxState;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { reviews: {} };
}

async function save(store: CanvasStore, canvasId: string, state: InboxState): Promise<void> {
  const file = fileFor(store, canvasId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, file);
}

function validFinding(finding: SavedFinding, hashes: Map<string, string>): boolean {
  return Object.entries(finding.sourceHashes).every(([id, hash]) => hashes.get(id) === hash);
}

function response(canvasId: string, state: InboxState, hashes: Map<string, string>,
  errors: InboxResponse['errors'] = []): InboxResponse {
  const checkedBlockIds: string[] = [];
  const pendingBlockIds: string[] = [];
  const items: InsightItem[] = [];
  for (const [blockId, hash] of hashes) {
    const review = state.reviews[blockId];
    if (!review || review.hash !== hash) {
      if (state.errors?.[blockId]?.hash !== hash) pendingBlockIds.push(blockId);
      continue;
    }
    checkedBlockIds.push(blockId);
    for (const finding of review.findings ?? []) {
      if (!review.dismissed.includes(finding.item.id) && validFinding(finding, hashes)) items.push(finding.item);
    }
  }
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  unique.sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title));
  const recorded = Object.entries(state.errors ?? {}).flatMap(([blockId, error]) =>
    hashes.get(blockId) === error.hash ? [{ blockId, message: error.message }] : []);
  return { canvasId, items: unique, checkedBlockIds, pendingBlockIds, errors: [...recorded, ...errors]
    .filter((error, index, all) => all.findIndex(other => other.blockId === error.blockId) === index) };
}

async function readInbox(store: CanvasStore, canvasId: string): Promise<{ state: InboxState; hashes: Map<string, string> }> {
  const canvas = await store.getCanvas(canvasId);
  const state = await load(store, canvasId);
  const hashes = new Map(canvas.blocks.map(block => [block.id, block.contentHash ?? '']));
  return { state, hashes };
}

/** A GET checks at most two changed documents; later GETs advance the finite queue. Failed hashes require explicit retry. */
export async function getJevInbox(store: CanvasStore, canvasId: string,
  decider: JevDecider = decideWithJev, retryFailed = false): Promise<InboxResponse> {
  const key = `${store.root}:${canvasId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    const { state, hashes } = await readInbox(store, canvasId);
    const pending = [...hashes].filter(([id, hash]) => state.reviews[id]?.hash !== hash
      && (retryFailed || state.errors?.[id]?.hash !== hash));
    const errors: InboxResponse['errors'] = [];
    if (pending.length) {
      for (const [blockId, hash] of pending.slice(0, maxChecksPerBatch)) {
        try {
          const report = await analyzeCanvas(store, canvasId, '', decider, {
            blockIds: [blockId], families: ['purpose', 'work_area', 'stale', 'steps', 'reviewer', 'links', 'similarity'],
          });
          const fresh = await store.getCanvas(canvasId);
          const freshHashes = new Map(fresh.blocks.map(block => [block.id, block.contentHash ?? '']));
          if (freshHashes.get(blockId) !== hash) continue;
          const findings = report.items.filter(item => item.category !== 'layout'
            && item.blockIds.every(id => freshHashes.get(id) === hashes.get(id)));
          state.reviews[blockId] = { hash, checkedAt: new Date().toISOString(), dismissed: [],
            findings: findings.map(item => ({ item,
              sourceHashes: Object.fromEntries(item.blockIds.map(id => [id, hashes.get(id) ?? ''])) })) };
          delete state.errors?.[blockId];
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Jev check failed';
          state.errors ??= {};
          state.errors[blockId] = { hash, message };
          errors.push({ blockId, message });
        }
      }
      await save(store, canvasId, state);
    }
    return response(canvasId, state, hashes, errors);
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

/** Dismiss only the matching finding for the document version that produced it. */
export async function dismissJevFinding(store: CanvasStore, canvasId: string, itemId: string): Promise<InboxResponse> {
  const { state, hashes } = await readInbox(store, canvasId);
  let matched = false;
  for (const [id, review] of Object.entries(state.reviews)) {
    if (review.hash !== hashes.get(id)) continue;
    if (review.findings.some(finding => finding.item.id === itemId && validFinding(finding, hashes))) {
      review.dismissed = [...new Set([...review.dismissed, itemId])];
      matched = true;
    }
  }
  if (!matched) throw new ApiError(404, 'Finding is no longer available');
  await save(store, canvasId, state);
  return response(canvasId, state, hashes);
}

/** Recheck all document hashes before applying a saved action. */
export async function applyJevFinding(store: CanvasStore, canvasId: string, itemId: string, actor: string): Promise<InboxResponse> {
  const { state, hashes } = await readInbox(store, canvasId);
  const finding = Object.entries(state.reviews).flatMap(([id, review]) => review.hash === hashes.get(id)
    ? review.findings.filter(entry => entry.item.id === itemId && validFinding(entry, hashes)
      && !review.dismissed.includes(itemId)) : [])[0];
  if (!finding) throw new ApiError(404, 'Finding is no longer available');
  if (!finding.item.action) throw new ApiError(400, 'This finding is review only');
  if (finding.item.action.type === 'merge' || finding.item.action.type === 'layout' || finding.item.action.type === 'move') {
    throw new ApiError(400, 'Open this finding in Insights to review its changes');
  }
  await applyInsightAction(store, canvasId, finding.item.action, actor);
  for (const review of Object.values(state.reviews)) {
    if (review.findings.some(entry => entry.item.id === itemId)) review.dismissed = [...new Set([...review.dismissed, itemId])];
  }
  await save(store, canvasId, state);
  const current = await store.getCanvas(canvasId);
  return response(canvasId, state, new Map(current.blocks.map(block => [block.id, block.contentHash ?? ''])));
}
