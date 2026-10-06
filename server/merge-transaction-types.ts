import type { MergeJournal } from './storage-shapes.js';

export type MergeRecoveryJournal = MergeJournal & { recovery?: 'merge' | 'undo' };
