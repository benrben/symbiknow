import type { BlockKind } from './types.js';

export type FileKind = BlockKind | 'html';
export interface WorkingCopyManifest {
  version: 1;
  checkoutId: string;
  callerId: string;
  workspaceId: string;
  canvasId: string;
  documentId: string;
  incarnation: string;
  branch: string;
  filename: string;
  title: string;
  kind: FileKind;
  storageKind: BlockKind;
  baseContentHash: string;
  baseRevision: string;
  basePackageHash?: string;
  createdAt: string;
}
export interface DownloadedFile {
  manifest: WorkingCopyManifest;
  content: string;
  filename: string;
  savedTo?: string;
  manifestPath?: string;
  documentPath?: string;
  sourceDirectory?: string;
}
export interface FileUploadInput {
  mode: 'replace' | 'create' | 'propose';
  canvasId: string;
  checkoutId?: string;
  filename: string;
  content: string;
  idempotencyKey: string;
  kind?: FileKind;
  title?: string;
  x?: number;
  y?: number;
  message?: string;
}
export interface FileUploadReceipt {
  status: 'saved' | 'proposed';
  saved: boolean;
  baseRevision?: string;
  operationId: string;
  mode: FileUploadInput['mode'];
  canvasId: string;
  blockId: string;
  branch: string;
  contentHash: string;
  revision: string;
  kind: FileKind;
  filename: string;
  title: string;
  savedAt: string;
  proposalId?: string;
}
