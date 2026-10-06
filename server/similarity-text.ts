import { documentText } from '../shared/document-text.js';

const wordPattern = /\p{L}[\p{L}\p{N}]{2,}/gu;
const stopWords = new Set([
  'the', 'and', 'for', 'are', 'with', 'from', 'this', 'that', 'have', 'was', 'were', 'not',
  'של', 'הוא', 'היא', 'אבל', 'היה', 'אשר', 'זאת', 'הם', 'הן',
  'это', 'как', 'для', 'что', 'или', 'его', 'она', 'они',
  'على', 'هذا', 'هذه', 'التي', 'كان', 'ليس',
]);

/** Lowercase Unicode words of at least three letters/digits, minus common words. */
export function tokenize(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().match(wordPattern) ?? [])
    .filter(word => !stopWords.has(word));
}

export function shingles(words: string[]): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= words.length - 5; index++) result.add(words.slice(index, index + 5).join('\u0000'));
  return result;
}

export function jaccard(first: Set<string>, second: Set<string>): number {
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const value of first) if (second.has(value)) shared++;
  return shared / (first.size + second.size - shared);
}

/** Jaccard overlap of five-word shingles from two readable document bodies. */
export function shingleOverlap(first: string, second: string): number {
  return jaccard(shingles(tokenize(documentText(first))), shingles(tokenize(documentText(second))));
}
