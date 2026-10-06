import type { AnswerSource } from '../shared/answer-canvas.js';
import { documentText } from '../shared/document-text.js';
import { normalizeEvidence } from '../shared/evidence.js';
import type { Candidate } from './answer-retrieval.js';

function sourceExcerpt(content: string, query: string): string {
  const text = documentText(content).replace(/\s+/gu, ' ').trim();
  const terms = query.toLocaleLowerCase().match(/\p{L}[\p{L}\p{N}]{2,}/gu) ?? [];
  const lower = text.toLocaleLowerCase();
  const match = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? -1;
  const start = match < 0 ? 0 : Math.max(0, match - 90);
  return `${start ? '…' : ''}${text.slice(start, start + 300)}${start + 300 < text.length ? '…' : ''}`;
}

function source(candidate: Candidate, score: number, query: string, checkedAt: string): AnswerSource {
  const excerpt = sourceExcerpt(candidate.block.content, query);
  const evidence = normalizeEvidence({ claim: `Candidate context for: ${query}`, passage: excerpt,
    sourceText: candidate.block.content, canvasId: candidate.canvas.id, documentId: candidate.block.id,
    documentTitle: candidate.block.title, contentHash: candidate.block.contentHash, checkedAt });
  return { canvasId: candidate.canvas.id, canvasName: candidate.canvas.name, blockId: candidate.block.id, title: candidate.block.title,
    excerpt, relevance: score, contentHash: candidate.block.contentHash, ...(evidence ? { evidence } : {}) };
}

export function answerSources(candidates: Candidate[], query: string): AnswerSource[] {
  const ranked = candidates.map(candidate => ({ candidate, score: Math.min(1, candidate.localScore) }))
    .filter(item => item.score >= 0.08)
    .sort((a, b) => b.score - a.score || b.candidate.localScore - a.candidate.localScore).slice(0, 7);
  const checkedAt = new Date().toISOString();
  return ranked.map(({ candidate, score }) => source(candidate, score, query, checkedAt));
}
