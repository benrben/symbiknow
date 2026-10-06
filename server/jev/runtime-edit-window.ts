import { ApiError } from '../errors.js';
import type { CanvasStore } from '../storage.js';
import type { JevStoreEvent } from './events.js';

async function sourceGeneration(store: CanvasStore, canvasId: string, blockId: string): Promise<number> {
  try { return (await store.getCanvasBlock(canvasId, blockId)).sourceGeneration ?? 1; }
  catch (error) { if (error instanceof ApiError && error.status === 404) return 1; throw error; }
}

export async function editQuietWindow(store: CanvasStore, event: JevStoreEvent, configured: number): Promise<number> {
  if (event.kind !== 'source' || !Number.isFinite(configured) || configured <= 0) return 0;
  const generations = await Promise.all(event.blockIds.map(blockId => sourceGeneration(store, event.canvasId, blockId)));
  // New imports start immediately. Revised sources wait before paid work is admitted.
  return generations.length && generations.every(generation => generation > 1) ? Math.min(configured, 2_000) : 0;
}
