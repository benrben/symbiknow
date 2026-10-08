import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SymbiIndexDocument, SymbiPassage, SymbiRetrievalResult } from '../shared/symbi-contract.js';
import { SYMBI_CONTRACT_VERSION } from '../shared/symbi-contract.js';
import { MiniLmEmbedder, type SymbiEmbedder } from './symbi-embedding.js';
import { cursorOffset, scopeSql, searchCoverage, type SearchScope } from './symbi-index-query.js';
import { chunkDocument, normalizeVector, queryTokens, rankPassages, validateIndexDocument,
  type IndexedPassage, type SymbiSearchRequest } from './symbi-retrieval.js';

type SqlValue = string | number | null | Uint8Array;
type SqlRow = Record<string, unknown>;
interface SqlStatement {
  run(...values: SqlValue[]): unknown;
  get(...values: SqlValue[]): SqlRow | undefined;
  all(...values: SqlValue[]): SqlRow[];
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface SymbiIndexOptions {
  dataDir: string;
  modelRoot?: string;
  embedder?: SymbiEmbedder;
  cacheBytes?: number;
  /** Optional logical SQLite I/O counters for an isolated benchmark. */
  trackStorage?: boolean;
}

export interface SymbiStorageStats {
  readOperations: number;
  rowsRead: number;
  bytesReturned: number;
  writeOperations: number;
  bytesBoundForWrites: number;
}

export interface SymbiIndexUpsertResult {
  changedChunks: number;
  reusedChunks: number;
  embeddedChunks: number;
  status: 'ready' | 'degraded';
  reason?: string;
  durationMs: number;
  queueWaitMs: number;
  storageWrites: number;
}

interface DocumentRow extends SqlRow {
  canvas_id: string;
  block_id: string;
  content_hash: string;
  status: string;
  indexed_at: string | null;
  reason: string | null;
}

interface PassageRow extends SqlRow {
  rowid: number;
  canvas_id: string;
  block_id: string;
  content_hash: string;
  title: string;
  tags: string;
  group_name: string;
  purpose: string;
  links: string;
  start_offset: number;
  end_offset: number;
  excerpt: string;
  chunk_hash: string;
  vector: Uint8Array | null;
  model_version: string | null;
}

interface StoredPassageRow extends SqlRow {
  rowid: number;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  chunk_hash: string;
  vector: Uint8Array | null;
  model_version: string | null;
}

type DocumentChunks = ReturnType<typeof chunkDocument>;
interface UpsertWork {
  doc: SymbiIndexDocument;
  chunks: DocumentChunks;
  old: StoredPassageRow[];
  oldByOrdinal: Map<number, StoredPassageRow>;
  vectors: (number[] | null)[];
  metadataChanged: boolean;
  reason?: string;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS index_documents (
  canvas_id TEXT NOT NULL, block_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  metadata_revision INTEGER, title TEXT NOT NULL, tags TEXT NOT NULL,
  group_name TEXT NOT NULL, purpose TEXT NOT NULL, links TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT, indexed_at TEXT,
  PRIMARY KEY (canvas_id, block_id)
);
CREATE TABLE IF NOT EXISTS index_passages (
  rowid INTEGER PRIMARY KEY, canvas_id TEXT NOT NULL, block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
  excerpt TEXT NOT NULL, chunk_hash TEXT NOT NULL, vector BLOB, model_version TEXT,
  UNIQUE (canvas_id, block_id, ordinal),
  FOREIGN KEY (canvas_id, block_id) REFERENCES index_documents(canvas_id, block_id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(title, excerpt, metadata);
CREATE INDEX IF NOT EXISTS index_passages_doc ON index_passages(canvas_id, block_id);
CREATE INDEX IF NOT EXISTS index_documents_status ON index_documents(status);
`;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metadataColumns(doc: SymbiIndexDocument) {
  return { title: doc.title, tags: JSON.stringify(doc.tags ?? []), group_name: doc.group ?? '',
    purpose: doc.purpose ?? '', links: JSON.stringify(doc.links ?? []) };
}

function metadataMatches(row: SqlRow | undefined, doc: SymbiIndexDocument): boolean {
  return Object.entries(metadataColumns(doc)).every(([key, value]) => row?.[key] === value);
}

function blob(vector: number[]): Uint8Array {
  const floats = new Float32Array(normalizeVector(vector));
  return new Uint8Array(floats.buffer);
}

function optionalBlob(vector: number[] | null): Uint8Array | null {
  return vector ? blob(vector) : null;
}

function vectorFromBlob(value: Uint8Array | null): number[] | null {
  if (!value) return null;
  const bytes = new Uint8Array(value);
  if (bytes.byteLength % 4) return null;
  return Array.from(new Float32Array(bytes.buffer));
}

function jsonStrings(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function transaction<T>(db: SqlDatabase, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function valueBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  return aggregateBytes(value);
}

function aggregateBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + valueBytes(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + valueBytes(item), 0);
  return 0;
}

function trackedDatabase(db: SqlDatabase, counters: SymbiStorageStats): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...values) => {
          counters.writeOperations += 1;
          counters.bytesBoundForWrites += valueBytes(values);
          return statement.run(...values);
        },
        get: (...values) => {
          const row = statement.get(...values);
          counters.readOperations += 1;
          counters.rowsRead += row ? 1 : 0;
          counters.bytesReturned += valueBytes(row);
          return row;
        },
        all: (...values) => {
          const rows = statement.all(...values);
          counters.readOperations += 1;
          counters.rowsRead += rows.length;
          counters.bytesReturned += valueBytes(rows);
          return rows;
        },
      };
    },
  };
}

export class SymbiIndex {
  private generation = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16);
  private mutation = Promise.resolve();
  private cache = new Map<string, { value: SymbiPassage[]; bytes: number }>();
  private cacheSize = 0;
  private dataVersion?: number;
  private readonly maxCacheBytes: number;
  private closed = false;

  constructor(private readonly db: SqlDatabase, private readonly embedder: SymbiEmbedder,
    options: { cacheBytes?: number; counters?: SymbiStorageStats } = {}) {
    this.maxCacheBytes = Math.max(0, Math.min(options.cacheBytes ?? 4 * 1024 * 1024, 64 * 1024 * 1024));
    this.counters = options.counters;
    db.exec(SCHEMA);
  }

  private readonly counters?: SymbiStorageStats;

  storageStats(): SymbiStorageStats | null {
    return this.counters ? { ...this.counters } : null;
  }

  /** Mark an authoritative file as needing indexing, before scheduling an update. */
  markPending(doc: Pick<SymbiIndexDocument, 'canvasId' | 'blockId' | 'contentHash' | 'title'>): void {
    this.assertOpen();
    this.db.prepare(`INSERT INTO index_documents(canvas_id,block_id,content_hash,title,tags,group_name,purpose,links,status)
      VALUES(?,?,?,?,'[]','','','[]','pending') ON CONFLICT(canvas_id,block_id) DO UPDATE SET
      content_hash=excluded.content_hash,title=excluded.title,status='pending',reason=NULL`).run(
      doc.canvasId, doc.blockId, doc.contentHash, doc.title);
    this.invalidate();
  }

  async upsert(doc: SymbiIndexDocument): Promise<SymbiIndexUpsertResult> {
    validateIndexDocument(doc);
    const queuedAt = performance.now();
    return this.enqueue(() => this.upsertNow(doc, performance.now() - queuedAt));
  }

  private async embedMissing(missing: { index: number; text: string }[], vectors: (number[] | null)[]): Promise<string | undefined> {
    try {
      for (let offset = 0; offset < missing.length; offset += 16) {
        const batch = missing.slice(offset, offset + 16);
        const embedded = await this.embedder.embed(batch.map((item) => item.text));
        if (embedded.length !== batch.length) throw new Error('Embedding worker returned incomplete batch');
        batch.forEach((item, index) => { vectors[item.index] = embedded[index]; });
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  }

  private sameReadyDocument(doc: SymbiIndexDocument, current: SqlRow | undefined): boolean {
    return current?.content_hash === doc.contentHash && current?.metadata_revision === (doc.metadataRevision ?? null)
      && metadataMatches(current, doc) && current?.status === 'ready';
  }

  private unchangedChunkCount(doc: SymbiIndexDocument, current: SqlRow | undefined): number | null {
    if (!this.sameReadyDocument(doc, current)) return null;
    const stale = this.db.prepare(`SELECT 1 AS stale FROM index_passages WHERE canvas_id=? AND block_id=?
      AND (model_version IS NULL OR model_version != ? OR vector IS NULL OR length(vector)=0
        OR length(vector)%4 != 0) LIMIT 1`).get(doc.canvasId, doc.blockId, this.embedder.modelVersion);
    if (stale) return null;
    const count = this.db.prepare('SELECT count(*) AS count FROM index_passages WHERE canvas_id=? AND block_id=?')
      .get(doc.canvasId, doc.blockId);
    return Number(count!.count);
  }

  private async upsertNow(doc: SymbiIndexDocument, queueWaitMs: number): Promise<SymbiIndexUpsertResult> {
    const started = performance.now();
    const current = this.db.prepare('SELECT * FROM index_documents WHERE canvas_id=? AND block_id=?')
      .get(doc.canvasId, doc.blockId);
    const unchanged = this.unchangedChunkCount(doc, current);
    if (unchanged !== null) {
      return { changedChunks: 0, reusedChunks: unchanged, embeddedChunks: 0,
        status: 'ready', durationMs: performance.now() - started, queueWaitMs, storageWrites: 0 };
    }
    this.markPending(doc);
    const chunks = chunkDocument(doc.content);
    const old = this.db.prepare(`SELECT rowid,ordinal,start_offset,end_offset,chunk_hash,vector,model_version FROM index_passages
      WHERE canvas_id=? AND block_id=?`).all(doc.canvasId, doc.blockId) as StoredPassageRow[];
    const existing = new Map(old.map((row) => [String(row.chunk_hash), row]));
    const vectors: (number[] | null)[] = chunks.map((chunk) => {
      const row = existing.get(hash(chunk.excerpt));
      return row?.model_version === this.embedder.modelVersion ? vectorFromBlob(row.vector) : null;
    });
    const missing = chunks.flatMap((chunk, index) => vectors[index] ? [] : [{ index, text: chunk.excerpt }]);
    const reason = await this.embedMissing(missing, vectors);
    const changedChunks = chunks.filter((chunk, ordinal) => old.find((row) => Number(row.ordinal) === ordinal)?.chunk_hash !== hash(chunk.excerpt)).length;
    const oldByOrdinal = new Map(old.map((row) => [Number(row.ordinal), row]));
    const deleted = old.filter((row) => !chunks[Number(row.ordinal)]
      || row.chunk_hash !== hash(chunks[Number(row.ordinal)].excerpt)).length;
    const inserted = changedChunks;
    const metadataWrites = !metadataMatches(current, doc);
    const samePassageUpdates = chunks.filter((chunk, ordinal) => {
      const row = oldByOrdinal.get(ordinal);
      return row?.chunk_hash === hash(chunk.excerpt)
        && (Number(row.start_offset) !== chunk.startOffset || Number(row.end_offset) !== chunk.endOffset
          || row.model_version !== (vectors[ordinal] ? this.embedder.modelVersion : null));
    }).length;
    this.commitIndexUpdate({ doc, chunks, old, oldByOrdinal, vectors, reason, metadataChanged: metadataWrites });
    this.invalidate();
    return {
      changedChunks, reusedChunks: chunks.length - missing.length,
      embeddedChunks: missing.filter((item) => vectors[item.index]).length, status: reason ? 'degraded' : 'ready',
      reason, durationMs: performance.now() - started, queueWaitMs,
      storageWrites: 2 + deleted * 2 + inserted * 2 + samePassageUpdates
        + (metadataWrites ? (chunks.length - inserted) * 2 : 0),
    };
  }

  private commitIndexUpdate(work: UpsertWork): void {
    transaction(this.db, () => {
      const { doc } = work;
      const pending = this.db.prepare('SELECT content_hash FROM index_documents WHERE canvas_id=? AND block_id=?')
        .get(doc.canvasId, doc.blockId);
      if (pending?.content_hash !== doc.contentHash) throw new Error('Index update superseded by a newer source revision');
      // Embedding runs outside the transaction. A second index instance may have
      // inserted the same revision while this worker was embedding it.
      const old = this.db.prepare(`SELECT rowid,ordinal,start_offset,end_offset,chunk_hash,vector,model_version
        FROM index_passages WHERE canvas_id=? AND block_id=?`).all(doc.canvasId, doc.blockId) as StoredPassageRow[];
      const oldByOrdinal = new Map(old.map((row) => [Number(row.ordinal), row]));
      const concurrentPassageWrite = old.length !== work.old.length
        || old.some((row) => work.oldByOrdinal.get(Number(row.ordinal))?.rowid !== row.rowid);
      const current = { ...work, old, oldByOrdinal };
      this.writeDocumentRow(doc, work.reason);
      this.deleteObsoletePassages(old, work.chunks);
      this.writePassages(current, work.metadataChanged || concurrentPassageWrite);
    });
  }

  private writeDocumentRow(doc: SymbiIndexDocument, reason?: string): void {
    const columns = metadataColumns(doc);
    this.db.prepare(`UPDATE index_documents SET content_hash=?,metadata_revision=?,title=?,tags=?,group_name=?,purpose=?,links=?,
      status=?,reason=?,indexed_at=? WHERE canvas_id=? AND block_id=?`).run(
      doc.contentHash, doc.metadataRevision ?? null, columns.title, columns.tags, columns.group_name,
      columns.purpose, columns.links, reason ? 'degraded' : 'ready', reason ?? null,
      new Date().toISOString(), doc.canvasId, doc.blockId);
  }

  private deleteObsoletePassages(old: StoredPassageRow[], chunks: DocumentChunks): void {
    const removeFts = this.db.prepare('DELETE FROM passage_fts WHERE rowid=?');
    const removePassage = this.db.prepare('DELETE FROM index_passages WHERE rowid=?');
    for (const row of old) {
      const chunk = chunks[Number(row.ordinal)];
      if (chunk && row.chunk_hash === hash(chunk.excerpt)) continue;
      removeFts.run(Number(row.rowid));
      removePassage.run(Number(row.rowid));
    }
  }

  private writePassages(work: UpsertWork, metadataChanged: boolean): void {
    const statements = {
      insert: this.db.prepare(`INSERT INTO index_passages(canvas_id,block_id,ordinal,start_offset,end_offset,excerpt,chunk_hash,vector,model_version)
        VALUES(?,?,?,?,?,?,?,?,?)`),
      update: this.db.prepare('UPDATE index_passages SET start_offset=?,end_offset=?,vector=?,model_version=? WHERE rowid=?'),
      fts: this.db.prepare('INSERT INTO passage_fts(rowid,title,excerpt,metadata) VALUES(?,?,?,?)'),
      removeFts: this.db.prepare('DELETE FROM passage_fts WHERE rowid=?'),
    };
    const { doc } = work;
    const metadata = [doc.tags?.join(' ') ?? '', doc.group ?? '', doc.purpose ?? '', doc.links?.join(' ') ?? ''].join(' ');
    work.chunks.forEach((chunk, ordinal) => this.writePassage(work, chunk, ordinal, metadata, metadataChanged, statements));
  }

  private writePassage(work: UpsertWork, chunk: DocumentChunks[number], ordinal: number, metadata: string,
    metadataChanged: boolean, statements: { insert: SqlStatement; update: SqlStatement; fts: SqlStatement; removeFts: SqlStatement }): void {
    const { doc } = work;
    const same = work.oldByOrdinal.get(ordinal);
    const vector = work.vectors[ordinal];
    const modelVersion = vector ? this.embedder.modelVersion : null;
    if (same?.chunk_hash === hash(chunk.excerpt)) {
      if (this.passageNeedsUpdate(same, chunk, modelVersion)) {
        statements.update.run(chunk.startOffset, chunk.endOffset, optionalBlob(vector), modelVersion, Number(same.rowid));
      }
      if (metadataChanged) {
        statements.removeFts.run(Number(same.rowid));
        statements.fts.run(Number(same.rowid), doc.title, chunk.excerpt, metadata);
      }
      return;
    }
    const result = statements.insert.run(doc.canvasId, doc.blockId, ordinal, chunk.startOffset, chunk.endOffset,
      chunk.excerpt, hash(chunk.excerpt), optionalBlob(vector), modelVersion) as { lastInsertRowid: number | bigint };
    statements.fts.run(Number(result.lastInsertRowid), doc.title, chunk.excerpt, metadata);
  }

  private passageNeedsUpdate(row: StoredPassageRow, chunk: DocumentChunks[number], modelVersion: string | null): boolean {
    return Number(row.start_offset) !== chunk.startOffset || Number(row.end_offset) !== chunk.endOffset
      || row.model_version !== modelVersion || (modelVersion !== null && !vectorFromBlob(row.vector)?.length);
  }

  async remove(canvasId: string, blockId: string): Promise<void> {
    await this.enqueue(async () => {
      transaction(this.db, () => {
        const rows = this.db.prepare('SELECT rowid FROM index_passages WHERE canvas_id=? AND block_id=?').all(canvasId, blockId);
        for (const row of rows) this.db.prepare('DELETE FROM passage_fts WHERE rowid=?').run(Number(row.rowid));
        this.db.prepare('DELETE FROM index_documents WHERE canvas_id=? AND block_id=?').run(canvasId, blockId);
      });
      this.invalidate();
    });
  }

  /** Reconcile the rebuildable index with authoritative files and metadata. */
  async rebuild(documents: Iterable<SymbiIndexDocument> | AsyncIterable<SymbiIndexDocument>): Promise<void> {
    const seen = new Set<string>();
    for await (const doc of documents) {
      seen.add(`${doc.canvasId}\0${doc.blockId}`);
      if (this.needsRebuild(doc)) await this.upsert(doc);
    }
    const rows = this.db.prepare('SELECT canvas_id,block_id FROM index_documents').all();
    for (const row of rows) {
      if (!seen.has(`${row.canvas_id}\0${row.block_id}`)) await this.remove(String(row.canvas_id), String(row.block_id));
    }
  }

  private needsRebuild(doc: SymbiIndexDocument): boolean {
    const existing = this.db.prepare('SELECT content_hash,metadata_revision,status FROM index_documents WHERE canvas_id=? AND block_id=?')
      .get(doc.canvasId, doc.blockId);
    const oldModel = this.db.prepare(`SELECT 1 AS stale FROM index_passages WHERE canvas_id=? AND block_id=?
      AND (model_version IS NULL OR model_version != ? OR vector IS NULL OR length(vector)=0
        OR length(vector)%4 != 0) LIMIT 1`).get(doc.canvasId, doc.blockId, this.embedder.modelVersion);
    return existing?.content_hash !== doc.contentHash || existing?.metadata_revision !== (doc.metadataRevision ?? null)
      || existing?.status !== 'ready' || !!oldModel;
  }

  private keywordRanks(queryText: string, scope: SearchScope): Map<number, number> {
    const tokens = queryTokens(queryText);
    const ranks = new Map<number, number>();
    if (!tokens.length) return ranks;
    const query = tokens.map((token) => `"${token}"`).join(' OR ');
    const where = scope.where ? `${scope.where} AND d.status != 'pending'` : `WHERE d.status != 'pending'`;
    const rows = this.db.prepare(`SELECT p.rowid FROM passage_fts JOIN index_passages p ON p.rowid=passage_fts.rowid
      JOIN index_documents d ON d.canvas_id=p.canvas_id AND d.block_id=p.block_id
      ${where} AND passage_fts MATCH ? ORDER BY bm25(passage_fts) LIMIT 500`)
      .all(...scope.values, query);
    rows.forEach((row, index) => ranks.set(Number(row.rowid), index));
    return ranks;
  }

  private indexedPassages(scope: SearchScope): IndexedPassage[] {
    const where = scope.where ? `${scope.where} AND d.status != 'pending'` : `WHERE d.status != 'pending'`;
    const rows = this.db.prepare(`SELECT p.*,d.content_hash,d.title,d.tags,d.group_name,d.purpose,d.links
      FROM index_passages p JOIN index_documents d ON d.canvas_id=p.canvas_id AND d.block_id=p.block_id
      ${where}`).all(...scope.values) as PassageRow[];
    return rows.map((row) => ({
      rowid: Number(row.rowid), canvasId: row.canvas_id, blockId: row.block_id,
      contentHash: row.content_hash, title: row.title, tags: jsonStrings(row.tags), group: row.group_name,
      purpose: row.purpose, links: jsonStrings(row.links), startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset), excerpt: row.excerpt,
      vector: row.model_version === this.embedder.modelVersion ? vectorFromBlob(row.vector) : null,
    }));
  }

  private async rankSearch(request: SymbiSearchRequest, scope: SearchScope, initialReason?: string):
    Promise<{ ranked: SymbiPassage[]; reason?: string }> {
    const keywordRanks = this.keywordRanks(request.query, scope);
    const passages = this.indexedPassages(scope);
    let queryVector: number[] | undefined;
    let reason = initialReason;
    if (request.mode !== 'keyword' && passages.some((passage) => passage.vector)) {
      try { queryVector = normalizeVector((await this.embedder.embed([request.query]))[0]); }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    return { ranked: rankPassages({ passages, query: request.query, queryVector, keywordRanks, limit: 500,
      mode: request.mode, minimumSimilarity: request.minimumSimilarity, passagesPerDocument: request.passagesPerDocument,
      passageOrder: request.passageOrder }), reason };
  }

  private pageResult(ranked: SymbiPassage[], offset: number, limit: number, documents: DocumentRow[],
    request: SymbiSearchRequest, reason: string | undefined, generation: number, queryKey: string): SymbiRetrievalResult {
    const count = Math.min(ranked.length, offset + limit);
    return {
      version: SYMBI_CONTRACT_VERSION, passages: ranked.slice(offset, count),
      coverage: searchCoverage(documents, request, reason),
      nextCursor: count < ranked.length ? Buffer.from(JSON.stringify({ generation, queryKey, offset: count })).toString('base64url') : undefined,
    };
  }

  async search(request: SymbiSearchRequest, retry = 0): Promise<SymbiRetrievalResult> {
    this.assertOpen();
    this.refreshExternalWrites();
    const generation = this.generation;
    const limits = { minimumSimilarity: request.minimumSimilarity, passagesPerDocument: request.passagesPerDocument,
      passageOrder: request.passageOrder };
    const queryKey = hash(JSON.stringify({ query: request.query, mode: request.mode, limits, allowedCanvasIds: request.allowedCanvasIds,
      allowedDocumentIds: request.allowedDocumentIds, canvasId: request.canvasId, documentIds: request.documentIds }));
    const offset = cursorOffset(request.cursor, generation, queryKey);
    const limit = Math.max(1, Math.min(request.limit ?? 24, 100));
    const scope = scopeSql(request);
    const documents = this.db.prepare(`SELECT d.* FROM index_documents d ${scope.where}`).all(...scope.values) as DocumentRow[];
    let reason = documents.find((row) => row.status === 'degraded')?.reason ?? undefined;
    const cacheKey = JSON.stringify({ query: request.query, mode: request.mode, limits, scope, generation: this.generation });
    let ranked = this.cache.get(cacheKey)?.value;
    if (!ranked) {
      const result = await this.rankSearch(request, scope, reason);
      ranked = result.ranked;
      reason = result.reason;
      this.refreshExternalWrites();
      if (this.generation !== generation) return this.retrySearch(request, retry);
      this.putCache(cacheKey, ranked);
    }
    return this.pageResult(ranked, offset, limit, documents, request, reason, generation, queryKey);
  }

  private retrySearch(request: SymbiSearchRequest, retry: number): Promise<SymbiRetrievalResult> {
    if (request.cursor) throw new Error('Search cursor is stale or invalid');
    if (retry >= 2) throw new Error('Index changed during search; retry with current scope');
    return this.search(request, retry + 1);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutation;
    this.closed = true;
    await this.embedder.close?.();
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Symbi index is closed');
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutation.then(action);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.cacheSize = 0;
  }

  private refreshExternalWrites(): void {
    const version = Number(this.db.prepare('PRAGMA data_version').get()?.data_version);
    if (this.dataVersion !== undefined && version !== this.dataVersion) this.invalidate();
    this.dataVersion = version;
  }

  private putCache(key: string, value: SymbiPassage[]): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxCacheBytes) return;
    while (this.cacheSize + bytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value!;
      this.cacheSize -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, bytes });
    this.cacheSize += bytes;
  }
}

/** Opens a cache-only database; callers supply authoritative documents to rebuild(). */
export async function createSymbiIndex(options: SymbiIndexOptions): Promise<SymbiIndex> {
  await mkdir(options.dataDir, { recursive: true });
  const moduleName = 'better-sqlite3';
  const { default: Database } = await import(moduleName);
  const db = new Database(join(options.dataDir, 'symbi-index.sqlite')) as SqlDatabase;
  const counters = options.trackStorage ? { readOperations: 0, rowsRead: 0, bytesReturned: 0,
    writeOperations: 0, bytesBoundForWrites: 0 } : undefined;
  const measuredDb = counters ? trackedDatabase(db, counters) : db;
  const embedder = options.embedder ?? new MiniLmEmbedder({ modelRoot: options.modelRoot,
    cacheDir: join(options.dataDir, 'model-cache') });
  return new SymbiIndex(measuredDb, embedder, { ...options, counters });
}
