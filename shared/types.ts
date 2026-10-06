import type { EvidenceReference } from './evidence.js';
export type BlockKind = 'markdown' | 'slides' | 'website' | 'mdx';
/** Reading lanes kept for older canvases; groups use `lane:`, `area:`, `purpose:`, or `custom:` paths. */
export type DocumentLane = 'overview' | 'work' | 'reference' | 'followup';
export type DocumentGroup = string;
export type GroupBy = 'work_area' | 'purpose' | 'lane';

export type LinkRelation = 'prerequisite' | 'implements' | 'decision_for' | 'supersedes'
  | 'contradicts' | 'example_of' | 'same_topic' | 'related';
export interface CrossLink { canvasId: string; blockId: string; relation?: LinkRelation; confidence?: number }

export interface DocumentLock {
  owner: string;
  expiresAt: string;
  note?: string;
}

export interface CanvasBlock {
  id: string;
  title: string;
  file: string;
  kind: BlockKind;
  content: string;
  /** False in metadata-only responses; fetch this document before reading or editing its content. */
  contentLoaded?: boolean;
  /** Derived file version for refreshing a metadata-only card after an external source edit. */
  contentVersion?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  links: string[];
  linkTypes?: Record<string, LinkRelation>;
  crossLinks?: CrossLink[];
  quality?: { score: number; at: string };
  archived?: boolean;
  stale?: boolean;
  tags?: string[];
  purpose?: string;
  reviewer?: string;
  group?: DocumentGroup;
  workArea?: string;
  /** Server-owned identity and revision counters; restored bytes get a new generation. */
  incarnation?: string;
  sourceGeneration?: number;
  metadataRevision?: number;
  jevMutationId?: string;
  jevOwnership?: { pins: string[]; removedLabels: string[]; removedLinks: string[]; managed: string[] };
  headline?: string;
  freshness?: { reviewAt?: string; expiresAt?: string; effectiveAt?: string };
  processingExcluded?: boolean;
  /** Short hash of `content`; pass it back as `expectedContentHash` to avoid overwriting another agent's edit. */
  contentHash?: string;
  lock?: DocumentLock;
}

export interface CanvasDocument {
  /** Read-only display names for native group paths, hydrated from workspace vocabulary. */
  groupLabels?: Record<string, string>;
  id: string;
  name: string;
  workspaceId: string;
  blocks: CanvasBlock[];
}

export interface SearchHit {
  canvasId: string;
  canvasName: string;
  blockId: string;
  title: string;
  excerpt: string;
  group?: DocumentGroup;
  tags: string[];
  kind: BlockKind;
  matchIn: 'title' | 'body';
  retrieval?: { kind: 'exact' | 'phrase' | 'terms' | 'fuzzy_title' | 'semantic'; matchedTerms: string[] };
  /** Provenance checked against the current saved document during this search. */
  evidence?: EvidenceReference;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  canvases: { id: string; name: string }[];
}

export type ModelProvider = 'openrouter' | 'openai' | 'anthropic' | 'custom';
export type AgentPlugin = 'document_read' | 'document_write' | 'external_mcp';

export interface AgentProfile {
  id: string;
  name: string;
  instructions: string;
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Name of a saved secret sent as `Authorization: Bearer <secret>`. */
  bearerSecret?: string;
  /** Extra headers. Values may reference secrets as `${secret:NAME}`. */
  headers?: Record<string, string>;
}

export interface McpTokenInfo {
  id: string;
  name: string;
  access?: 'read' | 'propose' | 'write';
  allowedCanvasIds?: string[];
  tools?: string[];
  preview: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ChatSettings {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  systemPrompt: string;
  /** Whether the selected provider has a key. */
  hasApiKey: boolean;
  providerKeys?: Partial<Record<ModelProvider, boolean>>;
  agentProfile?: string;
  customProfiles?: AgentProfile[];
  agentPlugins?: AgentPlugin[];
  secretNames?: string[];
  mcpServers?: ExternalMcpServer[];
  mcpTokens?: McpTokenInfo[];
  groupBy?: GroupBy;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  message: string;
  changed: boolean;
  /** Document changes remain a proposal until the user reviews and applies it. */
  proposalId?: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface TaskComment {
  author: string;
  text: string;
  createdAt: string;
}

export interface CanvasTask {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /** Stable order within a status column on the Tasks canvas. */
  boardOrder?: number;
  assignee?: string;
  reviewer?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  jevMutationId?: string;
  revision?: number;
  /** ISO calendar date in UTC; a planning input. */
  dueDate?: string;
  dependsOnTaskIds?: string[];
  blockIds: string[];
  findingRef?: {
    id: string;
    title: string;
    canvasId: string;
    blockIds: string[];
    detail?: string;
    evidence?: Array<{ questionId: string; answer: string; excerpt: string; sourceIds?: string[]; sourceHashes?: Record<string, string> }>;
    references?: EvidenceReference[];
    suggestedOwner?: string;
    investigationId?: string;
  };
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
}
