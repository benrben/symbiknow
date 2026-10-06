import { access } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { git } from './version-git.js';
import { readSource } from './version-source.js';

async function pendingMerge(root: string): Promise<boolean> {
  try { await access(path.join(root, '.git', 'MERGE_HEAD')); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function abortFailedMerge(root: string, before: string): Promise<void> {
  try { await git(root, 'merge', '--abort'); }
  catch (error) {
    if (await pendingMerge(root) || await readSource(root) !== before) {
      throw new ApiError(409, `Merge failed and could not be rolled back: ${(error as Error).message}`);
    }
    // Git can reject a merge before opening one. With unchanged source and no
    // merge state, an unavailable abort needs no additional recovery.
  }
}
