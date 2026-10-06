import type { SymbiIndexDocument, SymbiPassage, SymbiRetrievalRequest } from '../shared/symbi-contract.js';

export interface IndexedPassage extends SymbiPassage {
  rowid: number;
  title: string;
  tags: string[];
  group: string;
  purpose: string;
  links: string[];
  vector: number[] | null;
}

export interface PassageChunk {
  startOffset: number;
  endOffset: number;
  excerpt: string;
}

/** UTF-16 offsets match JavaScript source slices and cover the entire source. */
export function chunkDocument(content: string, maxLength = 220): PassageChunk[] {
  if (!content) return [];
  const chunks: PassageChunk[] = [];
  let start = 0;
  while (start < content.length) {
    const end = chunkEnd(content, start, maxLength);
    chunks.push({ startOffset: start, endOffset: end, excerpt: content.slice(start, end) });
    start = end;
  }
  rebalanceTail(content, chunks);
  return chunks;
}

function chunkEnd(content: string, start: number, maxLength: number): number {
  const end = Math.min(start + maxLength, content.length);
  if (end === content.length) return end;
  const breakAt = Math.max(content.lastIndexOf(' ', end), content.lastIndexOf('\n', end));
  return breakAt > start + maxLength * 0.65 ? breakAt + 1 : end;
}

function rebalanceTail(content: string, chunks: PassageChunk[]): void {
  if (chunks.length > 1 && chunks[chunks.length - 1].excerpt.length < 80) {
    const last = chunks.pop()!;
    const previous = chunks.pop()!;
    const combined = previous.excerpt + last.excerpt;
    const split = Math.floor(combined.length / 2);
    const middle = previous.startOffset + split;
    chunks.push({ startOffset: previous.startOffset, endOffset: middle,
      excerpt: content.slice(previous.startOffset, middle) });
    chunks.push({ startOffset: middle, endOffset: last.endOffset,
      excerpt: content.slice(middle, last.endOffset) });
  }
}

export function normalizeVector(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map((value) => value / length) : vector.map(() => 0);
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return 0;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i];
  return sum;
}

const minimumSemanticSimilarity = 0.30;

function hasSubstantiveKeywordMatch(passage: IndexedPassage, tokens: string[]): boolean {
  const text = [passage.title, passage.excerpt, passage.tags.join(' '), passage.group,
    passage.purpose, passage.links.join(' ')].join(' ').toLocaleLowerCase();
  const words = new Set(text.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const required = Math.max(1, Math.ceil(tokens.length / 2));
  return tokens.filter((token) => words.has(token)).length >= required;
}

function hasRetrievalEvidence(passage: IndexedPassage, tokens: string[], keywordRank: number | undefined,
  semanticScore: number | undefined, mode: 'semantic' | 'keyword' | 'hybrid'): boolean {
  if (mode === 'keyword') return keywordRank !== undefined;
  if (semanticScore !== undefined && semanticScore >= minimumSemanticSimilarity) return true;
  return keywordRank !== undefined && hasSubstantiveKeywordMatch(passage, tokens);
}

export function queryTokens(query: string): string[] {
  const common = new Set(['about', 'after', 'and', 'are', 'can', 'could', 'does', 'for', 'from', 'how',
    'into', 'our', 'please', 'should', 'show', 'that', 'the', 'their', 'there', 'these', 'this', 'what',
    'when', 'where', 'which', 'with', 'would', 'you']);
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((token) => !common.has(token)).slice(0, 24);
}

function metadataScore(passage: IndexedPassage, tokens: string[]): number {
  const title = passage.title.toLocaleLowerCase();
  const meta = [passage.tags.join(' '), passage.group, passage.purpose, passage.links.join(' ')].join(' ').toLocaleLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    if (meta.includes(token)) score += 1;
  }
  return score / (tokens.length * 3);
}

export function rankPassages(options: {
  passages: IndexedPassage[];
  query: string;
  queryVector?: number[];
  keywordRanks: Map<number, number>;
  limit: number;
  mode?: 'semantic' | 'keyword' | 'hybrid';
}): SymbiPassage[] {
  const { passages, query, queryVector, keywordRanks, limit, mode = 'hybrid' } = options;
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const semantic = semanticRanks(passages, queryVector, mode);
  const scored = passages.map((passage) => scorePassage(passage, tokens, keywordRanks.get(passage.rowid),
    semantic.get(passage.rowid), mode));
  const matchedDocuments = new Set(scored.filter((entry) => entry.score > 0.003)
    .map((entry) => entry.passage.blockId));
  const sorted = scored.map((entry) => ({ ...entry,
    score: entry.score + (entry.passage.links.some((id) => matchedDocuments.has(id)) ? 0.0015 : 0),
  })).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareLocation(a.passage, b.passage));
  return selectPassages(sorted, limit).map(({ passage, score }) => ({
    canvasId: passage.canvasId, blockId: passage.blockId, contentHash: passage.contentHash,
    startOffset: passage.startOffset, endOffset: passage.endOffset, excerpt: passage.excerpt, score,
  }));
}

interface ScoredPassage { passage: IndexedPassage; score: number }

function compareLocation(left: IndexedPassage, right: IndexedPassage): number {
  return left.canvasId.localeCompare(right.canvasId) || left.blockId.localeCompare(right.blockId)
    || left.startOffset - right.startOffset;
}

function semanticRanks(passages: IndexedPassage[], queryVector: number[] | undefined,
  mode: 'semantic' | 'keyword' | 'hybrid'): Map<number, { rank: number; score: number }> {
  if (!queryVector || mode === 'keyword') return new Map();
  const semantic = passages.filter((passage) => passage.vector)
    .map((passage) => ({ passage, score: cosine(queryVector, passage.vector!) }))
    .sort((a, b) => b.score - a.score || compareLocation(a.passage, b.passage));
  return new Map(semantic.map((entry, index) => [entry.passage.rowid, { rank: index, score: entry.score }]));
}

function scorePassage(passage: IndexedPassage, tokens: string[], keywordRank: number | undefined,
  semanticRank: { rank: number; score: number } | undefined,
  mode: 'semantic' | 'keyword' | 'hybrid'): ScoredPassage {
  if (!hasRetrievalEvidence(passage, tokens, keywordRank, semanticRank?.score, mode)) return { passage, score: 0 };
  const keywordWeight = mode === 'semantic' ? 0.35 : 1;
  const keywordScore = keywordRank === undefined ? 0 : keywordWeight / (60 + keywordRank);
  const semanticScore = semanticRank && semanticRank.score >= minimumSemanticSimilarity ? 1 / (60 + semanticRank.rank) : 0;
  return { passage, score: keywordScore + semanticScore + metadataScore(passage, tokens) * 0.008 };
}

function selectPassages(sorted: ScoredPassage[], limit: number): ScoredPassage[] {
  const selected: ScoredPassage[] = [];
  const perDocument = new Map<string, number>();
  let excerptChars = 0;
  for (const entry of sorted) {
    const key = `${entry.passage.canvasId}\0${entry.passage.blockId}`;
    if ((perDocument.get(key) ?? 0) >= 3 || excerptChars + entry.passage.excerpt.length > 20_000) continue;
    selected.push(entry);
    perDocument.set(key, (perDocument.get(key) ?? 0) + 1);
    excerptChars += entry.passage.excerpt.length;
    if (selected.length >= limit) break;
  }
  return selected;
}

export function validateIndexDocument(doc: SymbiIndexDocument): void {
  if (!doc.canvasId || !doc.blockId || !doc.contentHash || typeof doc.content !== 'string') {
    throw new Error('Index document requires canvasId, blockId, contentHash, and content');
  }
}

export interface SymbiSearchRequest extends SymbiRetrievalRequest {
  mode?: 'semantic' | 'keyword' | 'hybrid';
  /** Optional document ACL filter, computed by the authorized API boundary. */
  allowedDocumentIds?: string[];
  /** Authoritative known documents; absent IDs are shown as pending coverage. */
  expectedDocumentIds?: string[];
}
