import { documentText } from '../shared/document-text.js';
import type { CanvasBlock } from '../shared/types.js';
import { maximumBodyLength, searchTerms } from './search-candidate-text.js';
import { nearTitleWord } from './search-candidate-fuzzy.js';
import type { CandidateText, SearchMatch } from './search-candidate-types.js';

export function candidateText(block: CanvasBlock, query: string, terms: string[]): CandidateText {
  const title = block.title;
  const body = documentText(block.content).slice(0, maximumBodyLength);
  const lowerTitle = title.toLocaleLowerCase();
  const lowerBody = body.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const titleAt = lowerTitle.indexOf(lowerQuery);
  const bodyAt = lowerBody.indexOf(lowerQuery);
  const titleWords = new Set(searchTerms(title));
  const bodyWords = new Set(searchTerms(body));
  const exactTerms = terms.filter(term => titleWords.has(term) || bodyWords.has(term));
  const fuzzyTerms = terms.filter(term => !exactTerms.includes(term)
    && [...titleWords].some(titleWord => nearTitleWord(term, titleWord)));
  const matchedTerms = [...exactTerms, ...fuzzyTerms];
  const adjacentPhrases = terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`);
  const phraseTitle = adjacentPhrases.map(phrase => lowerTitle.indexOf(phrase)).find(at => at >= 0) ?? -1;
  const phraseBody = adjacentPhrases.map(phrase => lowerBody.indexOf(phrase)).find(at => at >= 0) ?? -1;
  return { title, body, lowerTitle, lowerBody, titleWords, bodyWords, terms, exactTerms, fuzzyTerms, matchedTerms,
    titleAt, bodyAt, phraseTitle, phraseBody };
}

function directMatch(text: CandidateText): SearchMatch | null {
  const patterns: SearchMatch[] = [
    { kind: 'exact', matchIn: 'title', matchAt: text.titleAt, score: 1_000 },
    { kind: 'exact', matchIn: 'body', matchAt: text.bodyAt, score: 900 },
    { kind: 'phrase', matchIn: 'title', matchAt: text.phraseTitle, score: 750 },
    { kind: 'phrase', matchIn: 'body', matchAt: text.phraseBody, score: 650 },
  ];
  return patterns.find(pattern => pattern.matchAt >= 0) ?? null;
}

function enoughTerms(text: CandidateText): boolean {
  return text.terms.length > 0 && text.matchedTerms.length >= Math.min(2, text.terms.length)
    && text.matchedTerms.length / text.terms.length >= 0.3;
}

function termLocation(text: CandidateText): Pick<SearchMatch, 'matchIn' | 'matchAt'> {
  const titleMatches = text.exactTerms.filter(term => text.titleWords.has(term)).length + text.fuzzyTerms.length;
  const bodyMatches = text.exactTerms.filter(term => text.bodyWords.has(term)).length;
  const matchIn = titleMatches >= bodyMatches ? 'title' : 'body';
  const source = matchIn === 'title' ? text.lowerTitle : text.lowerBody;
  const matchAt = Math.max(0, text.matchedTerms.map(term => source.indexOf(term)).find(at => at >= 0) ?? 0);
  return { matchIn, matchAt };
}

function termMatch(text: CandidateText): SearchMatch | null {
  if (!enoughTerms(text)) return null;
  const kind = text.fuzzyTerms.length ? 'fuzzy_title' : 'terms';
  const location = termLocation(text);
  const score = (location.matchIn === 'title' ? 450 : 300) + Math.round(100 * text.matchedTerms.length / text.terms.length)
    - text.fuzzyTerms.length * 35;
  return { kind, ...location, score };
}

export function candidateMatch(text: CandidateText): SearchMatch | null {
  return directMatch(text) ?? termMatch(text);
}
