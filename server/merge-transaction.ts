import { rm } from 'node:fs/promises';
import { atomicJson } from './storage-files.js';
import type { StorageFiles } from './storage-files.js';
import type { MergeJournal } from './storage-shapes.js';

/** Persist Undo information first, and restore completed writes if a later step fails. */
export async function mergeTransaction(files: StorageFiles, journal: MergeJournal, apply: () => Promise<void>,
  restore: () => Promise<void>, intent: 'merge' | 'undo'): Promise<void> {
  const file = files.mergeFile(journal.mergeId);
  const working = journal as MergeJournal & { recovery?: 'merge' | 'undo' };
  working.recovery = intent;
  await atomicJson(file, { ...journal, recovery: intent }, 0o600);
  try {
    await apply();
    delete working.recovery;
    await atomicJson(file, { ...journal, recovery: undefined, ...(intent === 'undo' ? { undone: true } : {}) }, 0o600);
  }
  catch (error) {
    try {
      await restore();
      delete working.recovery;
      if (intent === 'merge') await rm(file, { force: true });
      else await atomicJson(file, { ...journal, recovery: undefined }, 0o600);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Merge write failed and restoration failed. Original snapshots remain in ${file}.`);
    }
    throw error;
  }
}
