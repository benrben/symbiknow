import type { CanvasDocument, CanvasTask, WorkspaceSummary } from '../shared/types.js';
import type { DocumentLocks } from './coordination.js';
import type { StorageFiles } from './storage-files.js';
import type { JevStoreEvent } from './jev/events.js';

/** Shared serialized persistence and canvas queries for the store's domain services. */
export interface StorageContext {
  readonly files: StorageFiles;
  readonly locks: DocumentLocks;
  getCanvas(id: string, includeArchived?: boolean): Promise<CanvasDocument>;
  getCanvasSummary(id: string): Promise<CanvasDocument>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listTasks(canvasId: string): Promise<CanvasTask[]>;
  writeTaskSnapshot(canvasId: string, before: CanvasTask[], after: CanvasTask[], actor: string): Promise<void>;
  saved?(event: JevStoreEvent): void;
}
