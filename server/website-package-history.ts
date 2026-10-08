import path from 'node:path';
import type { FileUploadReceipt } from '../shared/working-copy.js';
import { ApiError } from './errors.js';
import { readJournal } from './file-checkout-journal.js';
import { atomicJson, durableDocument } from './storage-files.js';
import { DocumentVersions } from './version-control.js';
import type { CanvasStore } from './storage.js';
import { exportWebsite, packageHash, parseWebsite, replaceWebsite, type WebsitePackage } from './website-working-copy.js';

function revisionPath(store: CanvasStore, documentId: string, revision: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(documentId) || !/^[a-f0-9]{40,64}$/.test(revision)) throw new ApiError(400, 'Invalid website revision identity');
  return path.join(store.root, 'file-packages', documentId, revision + '.json');
}
export async function saveWebsiteRevision(store: CanvasStore, documentId: string, revision: string, bundle: WebsitePackage): Promise<void> {
  await atomicJson(revisionPath(store, documentId, revision), bundle, 0o600);
}
export async function websiteRevision(store: CanvasStore, documentId: string, revision: string, documentContent: string): Promise<WebsitePackage> {
  const file = revisionPath(store, documentId, revision);
  const stored = await new DocumentVersions(path.join(store.root, '.versions', documentId)).packageContent(revision);
  const saved = stored ? parseWebsite(stored) : await readJournal<WebsitePackage>(file);
  if (saved) return { ...saved, documentContent };
  const bundle = parseWebsite((await exportWebsite(store, documentContent)).content);
  await saveWebsiteRevision(store, documentId, revision, bundle);
  return bundle;
}
export async function recordWebsiteReceipt(store: CanvasStore, receipt: FileUploadReceipt, bundle: WebsitePackage, actor = 'SymbiKnow'): Promise<void> {
  const versions = new DocumentVersions(path.join(store.root, '.versions', receipt.blockId));
  receipt.revision = await versions.commitPackage(receipt.branch, JSON.stringify(bundle), 'Upload website assets [upload:' + receipt.operationId + ']', actor);
  receipt.filename = receipt.blockId + '.symbi-site.json';
  await saveWebsiteRevision(store, receipt.blockId, receipt.revision, bundle);
}

async function requireCleanWebsite(store: CanvasStore, canvasId: string, documentId: string, content: string, actualHash: string): Promise<void> {
  const history = await store.documentHistory(canvasId, documentId);
  const expected = await websiteRevision(store, documentId, history.commits[0].id, content);
  if (packageHash(expected.files) !== actualHash) throw new ApiError(409, 'Website source assets have uncommitted changes; upload or preserve them before changing versions');
}
async function mutateWebsiteVersion(store: CanvasStore, canvasId: string, documentId: string, actor: string,
  versions: DocumentVersions, after: WebsitePackage, kind: string, change: () => Promise<unknown>) {
  const checkpoint = await versions.packageCheckpoint();
  const original = await store.getCanvasBlock(canvasId, documentId);
  try {
    await change();
    const status = await store.documentHistory(canvasId, documentId);
    const revision = await versions.commitPackage(status.current, JSON.stringify(after), 'Synchronize website assets after ' + kind, actor);
    await saveWebsiteRevision(store, documentId, revision, after);
  } catch (error) {
    await versions.restorePackageCheckpoint(checkpoint);
    await durableDocument(path.join(store.root, original.file), original.content);
    await store.switchDocumentBranch(canvasId, documentId, checkpoint.current, actor);
    throw error;
  }
}
/** Prepare assets before changing HEAD so any asset error leaves the document untouched. */
export async function changeWebsiteVersion(store: CanvasStore, canvasId: string, documentId: string,
  kind: 'switch' | 'merge' | 'restore', target: string, actor: string, change: () => Promise<Awaited<ReturnType<CanvasStore['documentHistory']>>>): Promise<Awaited<ReturnType<CanvasStore['documentHistory']>>> {
  return store.jevExecutor.serialized(async () => {
    const block = await store.getCanvasBlock(canvasId, documentId);
    if (block.kind !== 'website') return change();
    const versions = new DocumentVersions(path.join(store.root, '.versions', documentId));
    const preview = await store.previewDocumentVersion(canvasId, documentId, kind, target);
    const stored = await versions.previewPackage(kind, target);
    const bundle = stored ? parseWebsite(stored) : await websiteRevision(store, documentId, preview.revision.id, preview.after);
    const current = await exportWebsite(store, block.content);
    await requireCleanWebsite(store, canvasId, documentId, block.content, current.packageHash);
    const after = { ...bundle, documentContent: preview.after };
    await replaceWebsite(store, block.content, after, current.packageHash,
      () => mutateWebsiteVersion(store, canvasId, documentId, actor, versions, after, kind, change));
    return store.documentHistory(canvasId, documentId);
  });
}
