import type { CanvasStore } from '../storage.js';

export interface JevStoreEvent {
  workspaceId: string;
  canvasId: string;
  blockIds: string[];
  kind: 'source' | 'metadata' | 'move' | 'delete' | 'tasks';
  actor: string;
}

const listeners = new WeakMap<CanvasStore, (event: JevStoreEvent) => Promise<void>>();

export function subscribeJevStore(store: CanvasStore, listener: (event: JevStoreEvent) => Promise<void>): void {
  listeners.set(store, listener);
}

/** Secondary organization must never change the successful primary write outcome. */
export function publishJevStore(store: CanvasStore, event: JevStoreEvent): void {
  const listener = listeners.get(store);
  if (!listener) return;
  void listener(event).catch(() => console.error('Jev could not schedule saved knowledge; reconciliation will retry.'));
}
