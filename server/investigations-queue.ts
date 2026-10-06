import { realpath } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map<string, Promise<unknown>>();

async function queueKey(file: string): Promise<string> {
  try { return path.join(await realpath(path.dirname(file)), path.basename(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(file);
    throw error;
  }
}

export async function serial<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = await queueKey(file);
  const prior = queues.get(key) ?? Promise.resolve();
  // A failed save must release the queue so the next caller can retry independently.
  const run = prior.then(action, action);
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}
