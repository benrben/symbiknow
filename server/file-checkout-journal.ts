import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileUploadInput, FileUploadReceipt, WorkingCopyManifest } from '../shared/working-copy.js';
import { ApiError } from './errors.js';
import { atomicJson } from './storage-files.js';
import type { CanvasStore } from './storage.js';

export type UploadOperation = { operationId: string; callerId: string; fingerprint: string;
  input: FileUploadInput; receipt?: FileUploadReceipt };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function readJournal<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function checkoutPath(store: CanvasStore, id: string): string {
  if (!uuid.test(id)) throw new ApiError(400, 'Invalid checkoutId');
  return path.join(store.root, 'file-checkouts', id + '.json');
}
export async function readCheckout(store: CanvasStore, id: string): Promise<WorkingCopyManifest> {
  const value = await readJournal<WorkingCopyManifest>(checkoutPath(store, id));
  if (!value || value.version !== 1 || value.checkoutId !== id) throw new ApiError(404, 'Working copy not found; download the document again');
  return value;
}
export async function saveCheckout(store: CanvasStore, manifest: WorkingCopyManifest): Promise<void> {
  await atomicJson(checkoutPath(store, manifest.checkoutId), manifest, 0o600);
}
export function operationPath(store: CanvasStore, callerId: string, key: string): string {
  const id = createHash('sha256').update(JSON.stringify([callerId, key])).digest('hex');
  return path.join(store.root, 'file-uploads', id + '.json');
}
export function uploadFingerprint(input: FileUploadInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
export async function saveOperation(file: string, operation: UploadOperation): Promise<void> {
  await atomicJson(file, operation, 0o600);
}

/** A matching file alone cannot prove this operation committed it. Its revision marker can. */
export async function operationCommitted(store: CanvasStore, documentId: string, revision: string, operationId: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(revision) || !/^[a-zA-Z0-9_-]+$/.test(documentId)) throw new ApiError(409, 'Invalid saved revision identity');
  const { stdout } = await promisify(execFile)('git', ['show', '-s', '--format=%B', revision], {
    cwd: path.join(store.root, '.versions', documentId), encoding: 'utf8', maxBuffer: 4096,
  });
  return stdout.includes('[upload:' + operationId + ']');
}
