import { access } from 'node:fs/promises';
import path from 'node:path';
import { git } from './version-git.js';
import { readSource } from './version-source.js';

const initializations = new Map<string, Promise<void>>();

/** Instances reading the same document must wait for its initial commit. */
export async function serializeInitialization(root: string, initialize: () => Promise<void>): Promise<void> {
  const key = path.resolve(root);
  const previous = initializations.get(key) ?? Promise.resolve();
  const next = previous.then(initialize, initialize);
  initializations.set(key, next);
  try { await next; }
  finally { if (initializations.get(key) === next) initializations.delete(key); }
}

export async function hasRepository(root: string): Promise<boolean> {
  try { await access(path.join(root, '.git')); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function workingSource(root: string): Promise<string | undefined> {
  try { return await readSource(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function unbornRepository(root: string): Promise<boolean> {
  try { await git(root, 'rev-parse', '--verify', 'HEAD'); return false; }
  catch (error) {
    if ((error as Error).message.includes('Needed a single revision')) return true;
    throw error;
  }
}
