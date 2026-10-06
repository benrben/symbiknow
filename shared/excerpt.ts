import type { DocumentExcerpt, ExcerptFocus, ExcerptCandidate, ExcerptLine } from './excerpt-types.js';
import { linesAndOutline } from './excerpt-lines.js';
import { candidates } from './excerpt-candidates.js';
export type { DocumentExcerpt, ExcerptFocus } from './excerpt-types.js';

function aroundMatch(value: string, matchAt: number, limit: number): string {
  if (value.length <= limit) return value;
  const start = Math.max(0, Math.min(matchAt - Math.floor(limit / 3), value.length - limit));
  return value.slice(start, start + limit).trim();
}

/** Build a compact, question-specific view of a Markdown document. The outline is separate from the character budget. */
export function excerpt(content: string, options: { budget: number; focus?: ExcerptFocus }): DocumentExcerpt {
  if (!Number.isFinite(options.budget) || options.budget < 0) throw new RangeError('Excerpt budget must be a non-negative finite number');
  const source = content.replace(/\r\n?/gu, '\n');
  const budget = Math.floor(options.budget);
  const { lines, outline } = linesAndOutline(source);
  const headLimit = Math.floor(budget * 0.4);
  const tailLimit = Math.floor(budget * 0.2);
  const head = source.slice(0, headLimit);
  const tailStart = Math.max(head.length, source.length - tailLimit);
  const tail = source.slice(tailStart);
  const available = budget - headLimit - tailLimit;
  return { outline, head, tail, extracts: extractsFor(lines, options.focus, head.length, tailStart, available, source) };
}

function appendCandidate(candidate: ExcerptCandidate, extracts: string[], available: number): number | undefined {
  const separator = extracts.length ? 1 : 0;
  if (available <= separator) return undefined;
  // Every candidate has a non-whitespace match anchor and a positive allocation.
  const selected = aroundMatch(candidate.text, candidate.matchAt, available - separator);
  extracts.push(selected);
  return available - selected.length - separator;
}

function focusedExtracts(lines: ExcerptLine[], focus: ExcerptFocus, headLength: number, tailStart: number, available: number): string {
  const extracts: string[] = [];
  for (const candidate of candidates(lines, focus)) {
    if (candidate.start < headLength || candidate.start >= tailStart) continue;
    const remaining = appendCandidate(candidate, extracts, available);
    if (remaining === undefined) break;
    available = remaining;
    if (available <= 0) break;
  }
  return extracts.join('\n');
}

function extractsFor(lines: ExcerptLine[], focus: ExcerptFocus | undefined, headLength: number, tailStart: number, available: number, source: string): string {
  if (available <= 0) return '';
  if (focus) return focusedExtracts(lines, focus, headLength, tailStart, available);
  if (tailStart <= headLength) return '';
  const middleLength = Math.min(available, tailStart - headLength);
  const middleStart = headLength + Math.floor((tailStart - headLength - middleLength) / 2);
  return source.slice(middleStart, middleStart + middleLength).trim();
}
