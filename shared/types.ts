import type { EvidenceReference } from './evidence.js';
export type BlockKind = 'markdown' | 'slides' | 'website' | 'mdx';
/** Reading lanes kept for older canvases; groups use `lane:`, `area:`, `purpose:`, or `custom:` paths. */
export type DocumentLane = 'overview' | 'work' | 'reference' | 'followup';
export type DocumentGroup = string;
export type GroupBy = 'work_area' | 'purpose' | 'lane';
import type { JevPolicy } from './policy.js';

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
  /** Short hash of `content`; pass it back as `expectedContentHash` to avoid overwriting another agent's edit. */
  contentHash?: string;
  lock?: DocumentLock;
}

export interface CanvasDocument {
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
  /** Provenance checked against the current saved document during this search. */
  evidence?: EvidenceReference;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  canvases: { id: string; name: string }[];
}

export type ModelProvider = 'openrouter' | 'openai' | 'anthropic' | 'custom';
export type AgentPlugin = 'document_read' | 'document_write' | 'jev_insights' | 'tasks' | 'external_mcp';

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
  hasJevApiKey: boolean;
  reviewers: string;
  workAreas?: string;
  tagVocabulary?: string;
  jevPolicy?: Partial<JevPolicy>;
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
  assignee?: string;
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
