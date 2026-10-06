import type { CanvasBlock, SearchHit } from '../shared/types.js';

export type SearchCandidateHit = SearchHit & { retrieval: {
  kind: 'exact' | 'phrase' | 'terms' | 'fuzzy_title'; matchedTerms: string[];
} };

export type SearchMatch = { kind: SearchCandidateHit['retrieval']['kind']; matchIn: SearchHit['matchIn']; matchAt: number; score: number };
export type CandidateText = {
  title: string; body: string; lowerTitle: string; lowerBody: string; titleWords: Set<string>; bodyWords: Set<string>;
  terms: string[]; exactTerms: string[]; fuzzyTerms: string[]; matchedTerms: string[];
  titleAt: number; bodyAt: number; phraseTitle: number; phraseBody: number;
};
export type RankedCandidate = { hit: SearchCandidateHit; score: number; block: CanvasBlock; matchAt: number; exactTerms: string[] };
