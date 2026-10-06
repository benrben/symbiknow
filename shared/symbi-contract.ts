/** Version 1 of the shared search, claim-check, and progress wire contract. */
export const SYMBI_CONTRACT_VERSION = 1 as const;

export interface SymbiScope {
  canvasId?: string;
  documentIds?: string[];
}

export interface SymbiPassage {
  canvasId: string;
  blockId: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
  excerpt: string;
  score?: number;
}

export interface SymbiCoverage {
  status: 'ready' | 'pending' | 'degraded';
  checkedDocuments: number;
  eligibleDocuments: number;
  pendingDocuments: number;
  indexedAt?: string;
  reason?: string;
}

export interface SymbiProviderUsage {
  requests: number;
  questions: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

export interface SymbiRetrievalRequest extends SymbiScope {
  query: string;
  limit?: number;
  cursor?: string;
  principal?: string;
  /** The caller's authorized canvases, supplied by the API boundary. */
  allowedCanvasIds?: string[];
}

export interface SymbiIndexDocument {
  canvasId: string;
  blockId: string;
  title: string;
  content: string;
  contentHash: string;
  metadataRevision?: number;
  tags?: string[];
  group?: string;
  purpose?: string;
  links?: string[];
}

export interface SymbiRetrievalResult {
  version: typeof SYMBI_CONTRACT_VERSION;
  passages: SymbiPassage[];
  coverage: SymbiCoverage;
  nextCursor?: string;
}

export interface AskSymbiRequest extends SymbiScope {
  question: string;
  mode: 'semantic' | 'logic' | 'combined';
  limit?: number;
  cursor?: string;
  /** Resume a bounded logical check without repeating provider work. */
  continuationId?: string;
  navigate?: boolean;
}

export interface AskSymbiMatch {
  canvasId: string;
  blockId?: string;
  title: string;
  reason: string;
  passages: SymbiPassage[];
  href: string;
  confidence?: number;
}

export interface AskSymbiResult {
  version: typeof SYMBI_CONTRACT_VERSION;
  matches: AskSymbiMatch[];
  coverage: SymbiCoverage;
  providerUsage: SymbiProviderUsage;
  nextCursor?: string;
  continuationId?: string;
  navigation?: { canvasId: string; href: string; activated: boolean };
}

export interface SymbiReflexRequest extends SymbiScope {
  claim: string;
  comparisonDocumentId?: string;
}

export interface SymbiReflexResult {
  version: typeof SYMBI_CONTRACT_VERSION;
  verdict: 'yes' | 'no' | 'insufficient_evidence';
  confidence: number;
  explanation: string;
  passages: SymbiPassage[];
  coverage: SymbiCoverage;
  providerUsage: SymbiProviderUsage;
}

export type SymbiActionName = 'profile' | 'label' | 'link' | 'flag_duplicate' | 'file' | 'suggest_home_canvas';
export type SymbiActionState = 'waiting' | 'changed' | 'no_change' | 'failed';

export interface SymbiActionProgress {
  action: SymbiActionName;
  state: SymbiActionState;
  reason?: string;
  decisionId?: string;
}

export interface SymbiDocumentProgress {
  version: typeof SYMBI_CONTRACT_VERSION;
  jobId: string;
  canvasId: string;
  blockId: string;
  contentHash: string;
  checkpointId?: string;
  durable: boolean;
  updatedAt: string;
  actions: SymbiActionProgress[];
  timingsMs?: { queueWait: number; indexing: number; provider: number; durableCommit: number };
}
