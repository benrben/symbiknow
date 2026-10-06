import { tokenize } from './similarity.js';

export const maximumBodyLength = 200_000;
const queryWords = new Set(['how', 'what', 'why', 'which', 'where', 'when', 'who', 'whose', 'whom', 'does', 'can', 'could',
  'should', 'would', 'please', 'find', 'show', 'tell', 'about']);

/** Similarity tokens plus numeric-leading codes such as HTTP 429 and ticket 429s. */
export function searchTerms(value: string): string[] {
  const words = value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}]{2,}/gu) ?? [];
  return words.filter(word => !queryWords.has(word) && (/^\p{N}/u.test(word) || tokenize(word).length > 0));
}

export function excerptAt(text: string, matchAt: number, matchLength: number): string {
  const width = Math.max(180, matchLength);
  const start = Math.max(0, Math.min(matchAt - Math.floor((width - matchLength) / 2), text.length - width));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Convert a bounded lowercase-string offset back to the original UTF-16 source. */
export function originalMatchAt(source: string, matchAt: number): number {
  if (source.length === source.toLocaleLowerCase().length) return matchAt;
  let sourceAt = 0;
  let foldedAt = 0;
  let previousAt = 0;
  while (foldedAt < matchAt) {
    previousAt = sourceAt;
    const character = String.fromCodePoint(source.codePointAt(sourceAt)!);
    sourceAt += character.length;
    foldedAt += character.toLocaleLowerCase().length;
  }
  return Math.max(previousAt, sourceAt - (foldedAt - matchAt));
}

export function bestBodyLine(body: string, terms: string[], fallbackAt: number): string {
  const lines = body.split(/\r?\n/u);
  let best = '';
  let score = 0;
  for (const line of lines) {
    const current = new Set(searchTerms(line));
    const matches = terms.filter(term => current.has(term)).length;
    if (matches > score) { best = line.trim(); score = matches; }
  }
  if (best && best.length <= 240) return best;
  return excerptAt(body, Math.max(0, fallbackAt), terms[0]?.length ?? 0);
}
