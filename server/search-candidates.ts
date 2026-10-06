import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { documentText } from '../shared/document-text.js';
import { normalizeEvidence } from '../shared/evidence.js';

export type { SearchCandidateHit } from './search-candidate-types.js';
import type { SearchCandidateHit, RankedCandidate } from './search-candidate-types.js';
import { bestBodyLine, excerptAt, maximumBodyLength, originalMatchAt, searchTerms } from './search-candidate-text.js';
import { candidateMatch, candidateText } from './search-candidate-match.js';

const defaultLimit = 40;
const maximumLimit = 100;
const maximumQueryTerms = 12;

function candidate(canvas: CanvasDocument, block: CanvasBlock, query: string, terms: string[]): RankedCandidate | null {
  const text = candidateText(block, query, terms);
  const match = candidateMatch(text);
  if (!match) return null;
  const { kind, matchIn, score } = match;
  const source = matchIn === 'title' ? text.title : text.body;
  const matchAt = originalMatchAt(source, match.matchAt);
  const excerpt = excerptAt(source, matchAt, kind === 'exact' ? query.length : text.matchedTerms[0]?.length ?? 0);
  return { score, block, matchAt, exactTerms: text.exactTerms, hit: {
    canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: text.title, excerpt,
    group: block.group, tags: block.tags ?? [], kind: block.kind, matchIn,
    retrieval: { kind, matchedTerms: text.matchedTerms },
  } };
}

/** Bounded lexical candidate retrieval. It does not infer synonyms or meaning. */
export function searchCandidates(canvases: readonly CanvasDocument[], query: string,
  options: { limit?: number; checkedAt?: string } = {}): SearchCandidateHit[] {
  const needle = query.trim().replace(/\s+/gu, ' ');
  if (!needle) return [];
  const limit = Math.min(maximumLimit, Math.max(1, Math.floor(options.limit ?? defaultLimit)));
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const terms = [...new Set(searchTerms(needle))].slice(0, maximumQueryTerms);
  const ranked = canvases.flatMap(canvas => canvas.blocks.filter(block => !block.archived)
    .flatMap(block => candidate(canvas, block, needle, terms) ?? []));
  return ranked.sort((first, second) => second.score - first.score
    || first.hit.canvasName.localeCompare(second.hit.canvasName)
    || first.hit.title.localeCompare(second.hit.title)
    || first.hit.blockId.localeCompare(second.hit.blockId))
    .slice(0, limit).map(({ hit, block, matchAt, exactTerms }) => {
      const passage = hit.matchIn === 'body'
        ? bestBodyLine(documentText(block.content).slice(0, maximumBodyLength), exactTerms, matchAt)
        : hit.excerpt;
      const evidence = normalizeEvidence({ claim: needle, passage,
        ...(hit.matchIn === 'body' ? { sourceText: block.content } : {}),
        canvasId: hit.canvasId, documentId: hit.blockId, documentTitle: hit.title,
        contentHash: block.contentHash, checkedAt });
      return { ...hit, ...(evidence ? { evidence } : {}) };
    });
}
