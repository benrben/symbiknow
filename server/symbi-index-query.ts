import type { SymbiRetrievalResult } from '../shared/symbi-contract.js';
import type { SymbiSearchRequest } from './symbi-retrieval.js';

type SqlValue = string | number | null | Uint8Array;
export interface SearchScope { where: string; values: SqlValue[] }
export interface IndexDocumentCoverageRow {
  block_id: string;
  status: string;
  indexed_at: string | null;
}

function appendIdScope(column: string, ids: string[] | undefined, clauses: string[], values: SqlValue[]): void {
  if (!ids) return;
  clauses.push(`${column} IN (${ids.map(() => '?').join(',') || 'NULL'})`);
  values.push(...ids);
}

export function scopeSql(request: SymbiSearchRequest): SearchScope {
  if (request.principal && !request.allowedCanvasIds) throw new Error('Authorized canvas scope is required for principal search');
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  appendIdScope('d.canvas_id', request.allowedCanvasIds, clauses, values);
  if (request.canvasId) {
    clauses.push('d.canvas_id = ?');
    values.push(request.canvasId);
  }
  appendIdScope('d.block_id', request.documentIds, clauses, values);
  appendIdScope('d.block_id', request.allowedDocumentIds, clauses, values);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function matchingCursor(value: { generation: number; offset: number; queryKey: string },
  generation: number, queryKey: string): boolean {
  return value.generation === generation && value.queryKey === queryKey
    && Number.isSafeInteger(value.offset) && value.offset >= 0;
}

export function cursorOffset(cursor: string | undefined, generation: number, queryKey: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { generation: number; offset: number; queryKey: string };
    if (!matchingCursor(decoded, generation, queryKey)) throw new Error();
    return decoded.offset;
  } catch {
    throw new Error('Search cursor is stale or invalid');
  }
}

function missingExpectedDocuments(request: SymbiSearchRequest, documents: IndexDocumentCoverageRow[]): number {
  return request.expectedDocumentIds?.filter((id) =>
    (!request.allowedDocumentIds || request.allowedDocumentIds.includes(id))
    && !documents.some((row) => row.block_id === id)).length ?? 0;
}

export function searchCoverage(documents: IndexDocumentCoverageRow[], request: SymbiSearchRequest, reason?: string):
  SymbiRetrievalResult['coverage'] {
  const expected = missingExpectedDocuments(request, documents);
  const pending = documents.filter((row) => row.status === 'pending').length + expected;
  const ready = documents.filter((row) => row.status !== 'pending');
  const indexedAt = ready.map((row) => row.indexed_at).filter((value): value is string => !!value).sort()[0];
  return {
    status: pending ? 'pending' : documents.some((row) => row.status === 'degraded') || reason ? 'degraded' : 'ready',
    checkedDocuments: ready.length, eligibleDocuments: documents.length + expected,
    pendingDocuments: pending, indexedAt,
    reason: pending ? `${pending} document(s) awaiting indexing` : reason,
  };
}
