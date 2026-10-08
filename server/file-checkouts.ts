import { randomUUID } from 'node:crypto';
import type { JevPrincipal } from '../shared/jev-types.js';
import type { CanvasBlock } from '../shared/types.js';
import type { DownloadedFile, FileUploadInput, FileUploadReceipt, WorkingCopyManifest } from '../shared/working-copy.js';
import { asHtmlDocument, documentFilename, isHtmlDocument, uploadedSource } from '../shared/file-transfer.js';
import { createWebsite, exportWebsite, parseWebsite, replaceWebsite, packageHash } from './website-working-copy.js';
import { websiteRevision, recordWebsiteReceipt } from './website-package-history.js';
import { proposeBranchFile } from './file-branch-proposals.js';
import { ApiError } from './errors.js';
import { currentPrincipal, requireCanvas, requireTool } from './jev/authorization.js';
import { hasActiveJevDraft } from './jev/drafts.js';
import { operationCommitted, operationPath, readCheckout, readJournal, saveCheckout, saveOperation, uploadFingerprint, type UploadOperation } from './file-checkout-journal.js';
import { CanvasStore, contentHash } from './storage.js';

function requireFileAccess(principal: JevPrincipal, canvasId: string, tool: string, mode?: FileUploadInput['mode']): void {
  requireCanvas(principal, canvasId);
  requireTool(principal, [tool]);
  if (mode && principal.access !== 'write' && !(principal.access === 'propose' && mode === 'propose')) {
    throw new ApiError(403, 'This identity cannot commit shared document content');
  }
}
type BranchBlock = CanvasBlock & { revision: string; branch: string };
function checkoutManifest(principal: JevPrincipal, workspaceId: string, canvasId: string, block: BranchBlock,
  website?: { content: string; packageHash: string }): WorkingCopyManifest {
  return { version: 1, checkoutId: randomUUID(), callerId: principal.id, workspaceId, canvasId,
    documentId: block.id, incarnation: block.incarnation!, branch: block.branch,
    filename: website ? block.id + '.symbi-site.json' : documentFilename(block), title: block.title,
    kind: isHtmlDocument(block.content) ? 'html' : block.kind, storageKind: block.kind,
    baseContentHash: block.contentHash!, baseRevision: block.revision,
    ...(website ? { basePackageHash: website.packageHash } : {}), createdAt: new Date().toISOString() };
}
async function checkoutWebsite(store: CanvasStore, block: BranchBlock) {
  if (block.kind !== 'website') return undefined;
  const bundle = await websiteRevision(store, block.id, block.revision, block.content);
  return { content: JSON.stringify(bundle, null, 2), packageHash: packageHash(bundle.files) };
}
export async function checkoutFile(store: CanvasStore, principal: JevPrincipal,
  input: { canvasId: string; blockId: string; branch?: string }): Promise<DownloadedFile> {
  requireFileAccess(principal, input.canvasId, 'download_file');
  return store.jevExecutor.serialized(async () => {
    principal = await currentPrincipal(store, principal);
    requireFileAccess(principal, input.canvasId, 'download_file');
    await store.ensureJevStamps(input.canvasId);
    const canvas = await store.getCanvasSummary(input.canvasId);
    const history = await store.documentHistory(input.canvasId, input.blockId);
    const block = await store.readDocumentBranch(input.canvasId, input.blockId, input.branch ?? history.current);
    if (!block.contentHash || !block.incarnation) throw new ApiError(409, 'Document identity is unavailable; reload before downloading');
    const website = await checkoutWebsite(store, block);
    const manifest = checkoutManifest(principal, canvas.workspaceId, input.canvasId, block, website);
    await saveCheckout(store, manifest);
    return { manifest, filename: manifest.filename, content: website?.content ?? block.content };
  });
}
function validateUpload(input: FileUploadInput): void {
  if (Buffer.byteLength(input.content) > 999_900) throw new ApiError(413, 'The file is too large for a canvas document');
  if (input.mode === 'create' && input.checkoutId) throw new ApiError(400, 'A create upload cannot use a replacement checkout');
  if (input.mode !== 'create' && !input.checkoutId) throw new ApiError(400, 'checkoutId from download_file is required for replacement or proposal');
}
async function requireCheckout(store: CanvasStore, principal: JevPrincipal, input: FileUploadInput): Promise<WorkingCopyManifest> {
  const checkout = await readCheckout(store, input.checkoutId!);
  if (checkout.callerId !== principal.id || checkout.canvasId !== input.canvasId) throw new ApiError(403, 'The working copy belongs to another caller or canvas');
  const canvas = await store.getCanvasSummary(input.canvasId);
  const block = await store.getCanvasBlock(input.canvasId, checkout.documentId);
  if (canvas.workspaceId !== checkout.workspaceId || block.incarnation !== checkout.incarnation) {
    throw new ApiError(409, 'The downloaded document identity changed; download it again');
  }
  return checkout;
}
function replacementSource(input: FileUploadInput, checkout: WorkingCopyManifest): { content: string; kind: CanvasBlock['kind'] } {
  const kind = input.kind ?? checkout.kind;
  return { content: kind === 'html' ? asHtmlDocument(input.content) : input.content, kind: kind === 'html' ? 'markdown' : kind };
}
function receiptBranch(explicit?: string, documentBranch?: string, current?: string): string {
  const branch = explicit ?? documentBranch ?? current;
  if (!branch) throw new ApiError(500, 'The saved file branch could not be verified');
  return branch;
}
async function receiptRevision(store: CanvasStore, operation: UploadOperation,
  block: CanvasBlock & { revision?: string; branch?: string }, branch?: string) {
  if (block.revision) return verifiedRevision(block, block.revision, receiptBranch(branch, block.branch));
  const history = await store.documentHistory(operation.input.canvasId, block.id);
  return verifiedRevision(block, history.commits[0]?.id, receiptBranch(branch, block.branch, history.current));
}
function verifiedRevision(block: CanvasBlock, revision: string | undefined, branch: string) {
  if (!revision || !block.contentHash) throw new ApiError(500, 'The saved file revision could not be verified; retry the same upload key');
  return { revision, branch };
}
async function uploadReceipt(store: CanvasStore, operation: UploadOperation,
  block: CanvasBlock & { revision?: string; branch?: string }, branch?: string): Promise<FileUploadReceipt> {
  return { status: 'saved', saved: true,
    operationId: operation.operationId, mode: operation.input.mode, canvasId: operation.input.canvasId,
    blockId: block.id, ...(await receiptRevision(store, operation, block, branch)), contentHash: block.contentHash!,
    kind: isHtmlDocument(block.content) ? 'html' : block.kind, filename: documentFilename(block), title: block.title,
    savedAt: new Date().toISOString() };
}
async function createUpload(store: CanvasStore, principal: JevPrincipal, operation: UploadOperation): Promise<FileUploadReceipt> {
  const input = operation.input;
  const website = input.kind === 'website' ? parseWebsite(input.content) : undefined;
  const detected = website ? { title: input.filename.replace(/\.symbi-site\.json$/i, ''), kind: 'website' as const,
    content: website.documentContent } : uploadedSource(input.filename, input.content);
  const kind = input.kind ?? detected.kind;
  const save = async () => store.createBlock(input.canvasId, { title: input.title ?? detected.title,
    content: kind === 'html' ? asHtmlDocument(input.content) : detected.content,
    kind: kind === 'html' ? 'markdown' : kind, x: input.x, y: input.y,
    idempotencyKey: 'file-upload:' + operation.operationId }, principal.id);
  const block = website ? await createWebsite(store, website, operation.operationId, save) : await save();
  const receipt = await uploadReceipt(store, operation, block);
  if (website) await recordWebsiteReceipt(store, receipt, website, principal.id);
  return receipt;
}
type Replacement = { store: CanvasStore; principal: JevPrincipal; operation: UploadOperation; checkout: WorkingCopyManifest;
  current: BranchBlock; visibleBranch: string; website?: ReturnType<typeof parseWebsite>;
  source: ReturnType<typeof replacementSource> };
function parsedReplacement(input: FileUploadInput, checkout: WorkingCopyManifest) {
  const website = checkout.kind === 'website' ? parseWebsite(input.content) : undefined;
  if (website && input.kind && input.kind !== 'website') throw new ApiError(400, 'Website package replacements preserve the website loader');
  return { website, source: replacementSource(website ? { ...input, content: website.documentContent } : input, checkout) };
}
async function canRecoverUpload(context: Replacement, recovering: boolean): Promise<boolean> {
  const { current, checkout, source, store, operation } = context;
  return recovering && current.contentHash === contentHash(source.content) && current.revision !== checkout.baseRevision
    && operationCommitted(store, checkout.documentId, current.revision, operation.operationId);
}
async function recoverWebsiteUpload(context: Replacement): Promise<void> {
  const { store, current, checkout, website, operation } = context;
  if (!website || checkout.branch !== context.visibleBranch) return;
  const actual = (await exportWebsite(store, current.content)).packageHash;
  if (actual !== checkout.basePackageHash && actual !== packageHash(website.files)) throw new ApiError(409, 'Website assets changed during upload recovery');
  await replaceWebsite(store, current.content, website, actual, async () => undefined, operation.operationId);
}
async function recoverUpload(context: Replacement): Promise<FileUploadReceipt> {
  const { store, operation, current, checkout, website, principal } = context;
  await recoverWebsiteUpload(context);
  const receipt = await uploadReceipt(store, operation, current, checkout.branch);
  if (website) await recordWebsiteReceipt(store, receipt, website, principal.id);
  return receipt;
}
function requireCurrentCheckout(context: Replacement): void {
  if (context.current.revision !== context.checkout.baseRevision || context.current.contentHash !== context.checkout.baseContentHash) {
    throw new ApiError(409, 'The working copy is stale. Download the current file and merge your local edits.', { currentContentHash: context.current.contentHash });
  }
}
function privateMetadataChanged(input: FileUploadInput, title: string, kind: string): boolean {
  return (input.kind !== undefined && input.kind !== kind) || (input.title !== undefined && input.title !== title);
}
function visibleSourcePatch(context: Replacement) {
  const input = context.operation.input;
  return { ...(input.kind === undefined ? {} : { kind: context.source.kind }),
    ...(input.title === undefined ? {} : { title: input.title }) };
}
async function saveReplacementSource(context: Replacement): Promise<CanvasBlock & { revision?: string; branch?: string }> {
  const { store, principal, operation, checkout, source } = context;
  const input = operation.input;
  const message = (input.message ?? 'Upload ' + checkout.title).slice(0, 120) + ' [upload:' + operation.operationId + ']';
  const patch = { content: source.content, expectedContentHash: checkout.baseContentHash, message };
  if (checkout.branch === context.visibleBranch) {
    return store.updateBlock(input.canvasId, checkout.documentId, { ...patch,
      ...visibleSourcePatch(context) }, principal.id);
  }
  if (privateMetadataChanged(input, context.current.title, checkout.kind)) throw new ApiError(400, 'Private branch uploads preserve document title and loader');
  return store.editDocumentBranch(input.canvasId, checkout.documentId, checkout.branch, patch, principal.id);
}
async function saveReplacement(context: Replacement) {
  const saved = await saveReplacementSource(context);
  if (!context.website) return saved;
  const receipt = await uploadReceipt(context.store, context.operation, saved, context.checkout.branch);
  await recordWebsiteReceipt(context.store, receipt, context.website, context.principal.id);
  return { ...saved, revision: receipt.revision };
}
async function commitReplacement(context: Replacement): Promise<FileUploadReceipt> {
  const { store, website, current, checkout, operation } = context;
  const save = () => saveReplacement(context);
  const block = website && checkout.branch === context.visibleBranch
    ? await replaceWebsite(store, current.content, website, checkout.basePackageHash!, save, operation.operationId) : await save();
  if (block.content !== context.source.content) throw new ApiError(500, 'Saved file verification failed; retry the same upload key');
  return uploadReceipt(store, operation, block, checkout.branch);
}
async function replacementUpload(store: CanvasStore, principal: JevPrincipal, operation: UploadOperation,
  checkout: WorkingCopyManifest, recovering: boolean): Promise<FileUploadReceipt> {
  if (await hasActiveJevDraft(store.root, operation.input.canvasId, checkout.documentId)) {
    throw new ApiError(403, 'A reviewed draft is active. Resume, rebase, or cancel it before writing this source.');
  }
  const history = await store.documentHistory(operation.input.canvasId, checkout.documentId);
  const current = await store.readDocumentBranch(operation.input.canvasId, checkout.documentId, checkout.branch);
  const context: Replacement = { store, principal, operation, checkout, current, visibleBranch: history.current,
    ...parsedReplacement(operation.input, checkout) };
  if (await canRecoverUpload(context, recovering)) return recoverUpload(context);
  requireCurrentCheckout(context);
  return commitReplacement(context);
}
async function proposeUpload(store: CanvasStore, operation: UploadOperation, checkout: WorkingCopyManifest): Promise<FileUploadReceipt> {
  const { website, source } = parsedReplacement(operation.input, checkout);
  return proposeBranchFile(store, operation, checkout, source.content, website);
}
async function executeUpload(store: CanvasStore, principal: JevPrincipal, operation: UploadOperation,
  checkout: WorkingCopyManifest | undefined, recovering: boolean): Promise<FileUploadReceipt> {
  if (operation.input.mode === 'create') return createUpload(store, principal, operation);
  if (operation.input.mode === 'propose') return proposeUpload(store, operation, checkout!);
  return replacementUpload(store, principal, operation, checkout!, recovering);
}
async function beginOperation(file: string, principal: JevPrincipal, input: FileUploadInput) {
  const fingerprint = uploadFingerprint(input);
  const existing = await readJournal<UploadOperation>(file);
  if (existing && existing.fingerprint !== fingerprint) throw new ApiError(409, 'idempotencyKey already belongs to a different upload');
  const operation = existing ?? { operationId: randomUUID(), callerId: principal.id, fingerprint, input };
  return { operation, recovering: Boolean(existing) };
}
export async function commitFileUpload(store: CanvasStore, principal: JevPrincipal, input: FileUploadInput): Promise<FileUploadReceipt> {
  requireFileAccess(principal, input.canvasId, 'upload_file', input.mode);
  validateUpload(input);
  return store.jevExecutor.serialized(async () => {
    principal = await currentPrincipal(store, principal);
    requireFileAccess(principal, input.canvasId, 'upload_file', input.mode);
    const checkout = input.mode === 'create' ? undefined : await requireCheckout(store, principal, input);
    const file = operationPath(store, principal.id, input.idempotencyKey);
    const { operation, recovering } = await beginOperation(file, principal, input);
    if (operation.receipt) return operation.receipt;
    await saveOperation(file, operation);
    operation.receipt = await executeUpload(store, principal, operation, checkout, recovering);
    await saveOperation(file, operation);
    return operation.receipt;
  });
}
