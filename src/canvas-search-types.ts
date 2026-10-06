import type { SearchHit } from '../shared/types';

export type CanvasSearchProps = {
  query: string;
  hits: SearchHit[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  currentCanvasId: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  onReveal: (hit: SearchHit) => void;
  onEdit: (hit: SearchHit) => void;
  onOpenEvidence?: (hit: SearchHit) => void;
  currentContentHashes?: Record<string, string>;
};

export type SearchAction = 'reveal' | 'edit' | 'evidence';
export type PendingSearchAction = { hit: SearchHit; action: SearchAction };
export type SearchFilters = { canvas: string; group: string; tag: string; kind: string };
export type SearchFilterOptions = Record<keyof SearchFilters, { value: string; label: string }[]>;
