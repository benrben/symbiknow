export type ExcerptFocus = 'dates' | 'steps' | 'claims';
export type DocumentExcerpt = { outline: string; head: string; tail: string; extracts: string };
export type ExcerptLine = { text: string; start: number; inCode: boolean; stepSection: boolean };
export type ExcerptCandidate = { text: string; start: number; matchAt: number };
