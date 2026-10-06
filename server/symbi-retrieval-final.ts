import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SymbiIndexDocument } from '../shared/symbi-contract.js';
import { createSymbiIndex, type SymbiIndex, type SymbiIndexUpsertResult, type SymbiStorageStats } from './symbi-index.js';
import { MINILM_MODEL_VERSION, type SymbiEmbedder } from './symbi-embedding.js';

interface CopiedProbe {
  canvasId: string;
  documents: { id: string; title: string; content: string }[];
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function durationDistribution(values: number[]): { p50: number; p95: number; max: number } {
  if (!values.length) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1)! };
}

export function storageDelta(before: SymbiStorageStats | null, after: SymbiStorageStats | null): SymbiStorageStats {
  if (!before || !after) throw new Error('Retrieval proof requires storage counters');
  return {
    readOperations: after.readOperations - before.readOperations,
    rowsRead: after.rowsRead - before.rowsRead,
    bytesReturned: after.bytesReturned - before.bytesReturned,
    writeOperations: after.writeOperations - before.writeOperations,
    bytesBoundForWrites: after.bytesBoundForWrites - before.bytesBoundForWrites,
  };
}

export async function directoryBytes(path: string): Promise<number> {
  let size = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const item = await stat(child);
    size += item.isDirectory() ? await directoryBytes(child) : item.size;
  }
  return size;
}

function sourcePath(filesDir: string, blockId: string): string {
  return join(filesDir, `${blockId}.md`);
}

function derived(doc: { id: string; title: string; content: string }, canvasId: string): SymbiIndexDocument {
  return { canvasId, blockId: doc.id, title: doc.title, content: doc.content, contentHash: hash(doc.content) };
}

function longFixture(canvasId: string): SymbiIndexDocument {
  const paragraph = 'After each service restart, verify health, compare error rates, and record the chosen recovery checkpoint. ';
  const content = `# Extended incident runbook\n${paragraph.repeat(160)}\nFinal recovery note: restore the verified snapshot.`;
  return { canvasId, blockId: 'synthetic-long-document', title: 'Extended incident runbook',
    content, contentHash: hash(content) };
}

type ReadAuthoritative = (doc: SymbiIndexDocument) => Promise<SymbiIndexDocument>;

async function sourceHashesMatch(documents: SymbiIndexDocument[], readAuthoritative: ReadAuthoritative): Promise<boolean> {
  const initialHashes = new Map(documents.map((doc) => [doc.blockId, doc.contentHash]));
  const unchanged = [];
  for (const doc of documents) {
    const current = await readAuthoritative(doc);
    unchanged.push(current.contentHash === initialHashes.get(doc.blockId));
  }
  return unchanged.every(Boolean);
}

async function remainingSources(documents: SymbiIndexDocument[], deletedBlockId: string,
  readAuthoritative: ReadAuthoritative): Promise<SymbiIndexDocument[]> {
  const authoritative = [];
  for (const doc of documents) {
    if (doc.blockId === deletedBlockId) continue;
    authoritative.push(await readAuthoritative(doc));
  }
  return authoritative;
}

export async function rejectsUnscopedPrincipal(index: Pick<SymbiIndex, 'search'>): Promise<boolean> {
  try { await index.search({ query: 'new hire', principal: 'scoped-agent' }); }
  catch { return true; }
  return false;
}

export async function proveRetrievalRecovery(modelRoot: string, copiedFixturePath: string,
  options: { embedderFactory?: () => SymbiEmbedder; indexFactory?: typeof createSymbiIndex } = {}): Promise<Record<string, unknown>> {
  const copied = JSON.parse(await readFile(copiedFixturePath, 'utf8')) as CopiedProbe;
  const documents = [...copied.documents.map((doc) => derived(doc, copied.canvasId)), longFixture(copied.canvasId)];
  const root = await mkdtemp(join(tmpdir(), 'symbi-retrieval-final-'));
  const filesDir = join(root, 'files');
  const indexDir = join(root, 'derived-index');
  await mkdir(filesDir, { recursive: true });
  for (const doc of documents) await writeFile(sourcePath(filesDir, doc.blockId), doc.content);
  let sourceReadOperations = 0;
  let sourceReadBytes = 0;
  const readAuthoritative = async (doc: SymbiIndexDocument): Promise<SymbiIndexDocument> => {
    const content = await readFile(sourcePath(filesDir, doc.blockId), 'utf8');
    sourceReadOperations += 1;
    sourceReadBytes += Buffer.byteLength(content);
    return { ...doc, content, contentHash: hash(content) };
  };
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const cpuBefore = process.cpuUsage();
  const processIoBefore = process.resourceUsage();
  const indexOpenStarted = performance.now();
  const embedder = options.embedderFactory?.();
  const modelVersion = embeddingModelVersion(embedder);
  const openIndex = options.indexFactory ?? createSymbiIndex;
  let index: SymbiIndex | undefined;
  try {
    index = await openIndex({ dataDir: indexDir, modelRoot, trackStorage: true, embedder });
    const indexOpenMs = performance.now() - indexOpenStarted;
    const openedAt = performance.now();
    const storageBefore = index.storageStats();
    const cold: SymbiIndexUpsertResult[] = [];
    for (const doc of documents) cold.push(await index.upsert(await readAuthoritative(doc)));
    const coldTotalMs = performance.now() - openedAt;
    const coldStorage = storageDelta(storageBefore, index.storageStats());
    const coldDiskBytes = await directoryBytes(indexDir);
    const sourceUnchanged = await sourceHashesMatch(documents, readAuthoritative);
    const warmStarted = performance.now();
    const warmBefore = index.storageStats();
    const warm: SymbiIndexUpsertResult[] = [];
    for (const doc of documents) warm.push(await index.upsert(doc));
    const warmTotalMs = performance.now() - warmStarted;
    const warmStorage = storageDelta(warmBefore, index.storageStats());
    const warmDiskBytes = await directoryBytes(indexDir);
    const longResult = await index.search({ query: 'Final recovery note restore the verified snapshot',
      documentIds: ['synthetic-long-document'], mode: 'keyword' });
    const longCovered = longResult.passages.some((passage) => passage.startOffset > 10_000);

    const rollback = documents.find((doc) => doc.title === 'Rollback procedure')!;
    const newerContent = `${rollback.content}\n\nRecovery revision: verify the deployment owner signed off.`;
    await writeFile(sourcePath(filesDir, rollback.blockId), newerContent);
    const updatedRollback = await readAuthoritative(rollback);
    index.markPending(updatedRollback);
    const pendingSearch = await index.search({ query: 'rollback procedure', documentIds: [rollback.blockId],
      expectedDocumentIds: [rollback.blockId] });
    const pendingExcludesStale = pendingSearch.coverage.status === 'pending' && pendingSearch.passages.length === 0;
    await index.upsert(updatedRollback);
    const freshSearch = await index.search({ query: 'Recovery revision verify deployment owner',
      documentIds: [rollback.blockId], mode: 'keyword' });
    const updatedVisible = freshSearch.passages.some((passage) => passage.contentHash === updatedRollback.contentHash);

    const deleted = documents.find((doc) => doc.title === 'First-week onboarding')!;
    await unlink(sourcePath(filesDir, deleted.blockId));
    await index.remove(deleted.canvasId, deleted.blockId);
    const deletedSearch = await index.search({ query: 'first week onboarding', documentIds: [deleted.blockId] });
    const deletedAbsent = deletedSearch.passages.length === 0 && deletedSearch.coverage.eligibleDocuments === 0;

    const allowed = await index.search({ query: 'new hire', principal: 'scoped-agent',
      allowedCanvasIds: [copied.canvasId], allowedDocumentIds: [rollback.blockId] });
    const permissionFiltered = allowed.passages.every((passage) => passage.blockId === rollback.blockId)
      && allowed.coverage.eligibleDocuments === 1;
    const missingPermissionRejected = await rejectsUnscopedPrincipal(index);

    const recoveryDoc = documents.find((doc) => doc.title === 'Release validation')!;
    const recoveryContent = `${recoveryDoc.content}\nRecovered after restart.`;
    await writeFile(sourcePath(filesDir, recoveryDoc.blockId), recoveryContent);
    const updatedRecovery = await readAuthoritative(recoveryDoc);
    index.markPending(updatedRecovery);
    await index.close();
    index = await openIndex({ dataDir: indexDir, modelRoot, trackStorage: true,
      embedder: options.embedderFactory?.() });
    const restartPending = await index.search({ query: 'release validation', documentIds: [recoveryDoc.blockId],
      expectedDocumentIds: [recoveryDoc.blockId] });
    const pendingSurvivedRestart = restartPending.coverage.status === 'pending'
      && restartPending.passages.length === 0;
    const authoritative = await remainingSources(documents, deleted.blockId, readAuthoritative);
    const rebuildStarted = performance.now();
    const rebuildBefore = index.storageStats();
    await index.rebuild(authoritative);
    const rebuildMs = performance.now() - rebuildStarted;
    const rebuildStorage = storageDelta(rebuildBefore, index.storageStats());
    const recovered = await index.search({ query: 'Recovered after restart', documentIds: [recoveryDoc.blockId],
      mode: 'keyword' });
    const restartRecovered = recovered.coverage.status === 'ready'
      && recovered.passages.some((passage) => passage.contentHash === updatedRecovery.contentHash);
    const deletedAfterRestart = await index.search({ query: 'first week onboarding', documentIds: [deleted.blockId] });
    const noDeletedAfterRestart = deletedAfterRestart.passages.length === 0;
    const finalDiskBytes = await directoryBytes(indexDir);
    const processIoAfter = process.resourceUsage();
    const proof = { sourceUnchangedBeforeIntentionalFixtureEdits: sourceUnchanged,
      longDocumentTailIndexed: longCovered, pendingExcludesStale, updatedRevisionVisible: updatedVisible,
      deletedSourceAbsent: deletedAbsent, permissionFiltered, missingPermissionRejected,
      pendingSurvivedRestart, restartRecovered, deletedAbsentAfterRestart: noDeletedAfterRestart };
    const failed = Object.entries(proof).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length) throw new Error(`Retrieval recovery proof failed: ${failed.join(', ')}`);
    return {
      fixture: { copiedSource: copiedFixturePath, copiedDocuments: copied.documents.length,
        syntheticLongDocuments: 1, sourceFilesAreOrdinaryMarkdown: true },
      proof,
      cold: { processColdWithFreshIndexDirectory: true, modelDiskCacheCleared: false,
        indexOpenMs, totalIndexingMs: coldTotalMs, bootstrapThroughIndexingMs: indexOpenMs + coldTotalMs,
        firstDocumentMs: cold[0]?.durationMs, executionMs: durationDistribution(cold.map((item) => item.durationMs)),
        queueWaitMs: durationDistribution(cold.map((item) => item.queueWaitMs)),
        executionMissesOver2000Ms: cold.map((item, index) => ({ blockId: documents[index].blockId,
          durationMs: item.durationMs })).filter((item) => item.durationMs > 2000),
        storage: coldStorage, indexDiskBytes: coldDiskBytes },
      warm: { totalIndexingMs: warmTotalMs, executionMs: durationDistribution(warm.map((item) => item.durationMs)),
        storage: warmStorage, indexDiskBytes: warmDiskBytes },
      restart: { rebuildMs, storage: rebuildStorage, finalIndexDiskBytes: finalDiskBytes },
      sourceReads: { operations: sourceReadOperations, bytes: sourceReadBytes },
      embeddingModel: modelVersion,
      modelArtifactBytes: await modelArtifactBytes(modelRoot, embedder),
      resources: { cpuMicros: process.cpuUsage(cpuBefore), rssBefore,
        rssAfter: process.memoryUsage().rss, sampledPeakRss: Math.max(peakRss, process.memoryUsage().rss),
        processFsReadOperations: processIoAfter.fsRead - processIoBefore.fsRead,
        processFsWriteOperations: processIoAfter.fsWrite - processIoBefore.fsWrite },
      providerRequests: 0,
      limits: ['Fresh process and index directory do not guarantee uncached model bytes in the operating-system page cache.',
        'SQLite storage counters measure logical row reads and bound write bytes, not physical device bytes.',
        'Operating-system fsRead/fsWrite counters returned zero here and are not evidence of no file I/O.',
        'Source file read bytes are exact for this script; full upload-to-durable and Jev execution are outside retrieval proof.',
        ...injectedEmbedderLimit(embedder)],
    };
  } finally {
    clearInterval(sample);
    try { await index?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

export function embeddingModelVersion(embedder?: SymbiEmbedder): string {
  return embedder?.modelVersion ?? MINILM_MODEL_VERSION;
}

export async function modelArtifactBytes(modelRoot: string, embedder?: SymbiEmbedder): Promise<number | null> {
  return embedder ? null : (await stat(join(modelRoot, 'Xenova', 'all-MiniLM-L6-v2', 'model_int8.onnx'))).size;
}

export function injectedEmbedderLimit(embedder?: SymbiEmbedder): string[] {
  return embedder ? ['An injected embedder was used; these timings do not measure MiniLM model execution.'] : [];
}

if (process.argv[1]?.endsWith('symbi-retrieval-final.ts')) {
  const modelRoot = process.argv[2];
  if (!modelRoot) throw new Error('Usage: node --import tsx server/symbi-retrieval-final.ts MODEL_ROOT [OUTPUT_JSON]');
  const source = resolve('work/jev-live-20261005/five-documents.json');
  const output = process.argv[3] && resolve(process.argv[3]);
  const result = await proveRetrievalRecovery(modelRoot, source);
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}
