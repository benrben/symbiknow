import { readFile } from 'node:fs/promises';
import type { CanvasTask } from '../shared/types.js';
import { ApiError } from './errors.js';
import type { StorageFiles } from './storage-files.js';
import type { MergeJournal, StoredBlock, StoredCanvas } from './storage-shapes.js';

function snapshot(value: unknown, before: unknown, after: unknown): boolean {
  const current = JSON.stringify(value);
  return current === JSON.stringify(before) || current === JSON.stringify(after);
}

/** A pending operation may have applied either atomic snapshot, but subsequent edits still block recovery. */
export async function recoverableMerge(files: StorageFiles, journal: MergeJournal, tasks: CanvasTask[]): Promise<StoredBlock> {
  const current = await files.readJson<StoredCanvas>(files.canvasFile(journal.canvasId));
  const keeper = current.blocks.find(block => block.id === journal.keepBlockId);
  const content = keeper ? await readFile(files.docFile(keeper.file), 'utf8') : undefined;
  const knownCanvas = snapshot(current, journal.beforeCanvas, journal.afterCanvas) ||
    journal.recoveryCanvases?.some(saved => JSON.stringify(saved) === JSON.stringify(current));
  if (!knownCanvas || !snapshot(tasks, journal.beforeTasks, journal.afterTasks)
    || !snapshot(content, journal.beforeContent, journal.afterContent)) throw new ApiError(409, 'Documents changed since the interrupted merge');
  await recoverableReferences(files, journal);
  return keeper!;
}

async function recoverableReferences(files: StorageFiles, journal: MergeJournal): Promise<void> {
  for (const other of journal.otherCanvases ?? []) {
    const current = await files.readJson<StoredCanvas>(files.canvasFile(other.id));
    if (!snapshot(current, other.before, other.after)) throw new ApiError(409, 'Cross-canvas links changed since the interrupted merge');
  }
}
