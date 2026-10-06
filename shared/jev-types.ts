import type { CanvasBlock, CanvasTask, LinkRelation } from './types.js';

export const jevActions = [
  'profile', 'file', 'label', 'suggest_home_canvas', 'link', 'flag_duplicate',
] as const;
export type JevCurrentAction = typeof jevActions[number];
/** Historical receipts remain readable and undoable; these names cannot be requested. */
export type JevAction = JevCurrentAction | 'vocab_lifecycle' | 'score_quality' | 'flag_conflict' | 'recheck_links'
  | 'attach_doc_to_task' | 'assign_owner' | 'recall' | 'set_headline' | 'set_freshness' | 'flag_sensitive'
  | 'order_reading' | 'suggest_archive' | 'mark_supersedes' | 'flag_gap' | 'create_task_from_line'
  | 'suggest_task_done' | 'prioritize' | 'where_to_put' | 'route_chat' | 'digest' | 'review_agent_edit';
export type JevMode = 'off' | 'shadow' | 'suggest' | 'auto';
export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson };
export type JevValues = { [key: string]: JevJson };
export interface JevPrincipal {
  id: string;
  kind: 'user' | 'token' | 'automation';
  access: 'read' | 'propose' | 'write';
  allowedCanvasIds?: string[];
  tools?: string[];
  canConfigure?: boolean;
  canApprove?: boolean;
}

export interface JevSourceSnapshot {
  workspaceId: string;
  canvasId: string;
  blockId: string;
  incarnation: string;
  sourceGeneration: number;
  contentHash: string;
  metadataRevision: number;
}
export interface JevPassage {
  source: JevSourceSnapshot;
  start: number;
  end: number;
  quote: string;
}
export interface JevOwnership {
  pins: string[];
  removedLabels: string[];
  removedLinks: string[];
  managed: string[];
}
export interface JevSettings {
  automaticPolicyVersion?: number;
  confidenceThresholds?: Partial<Record<JevCurrentAction, number>>;
  calibratedActions?: JevAction[];
  paused: boolean;
  externalProcessing: boolean;
  modes: Record<JevAction, JevMode>;
  people: Array<{ id: string; name: string; role: string }>;
  schedules: Array<{ id: string; canvasIds: string[]; timezone: string; time: string; enabled: boolean }>;
}
export interface JevActionRequest {
  action: JevAction;
  canvasId: string;
  blockIds?: string[];
  query?: string;
  options?: JevValues;
  idempotencyKey?: string;
}
type JevDocumentFields = Pick<CanvasBlock,
  'group' | 'tags' | 'purpose' | 'reviewer' | 'quality' | 'stale' | 'archived' | 'links' | 'linkTypes'
  | 'crossLinks' | 'headline' | 'freshness' | 'processingExcluded'>;
export type JevDocumentPatch = Partial<{ [Field in keyof JevDocumentFields]: JevDocumentFields[Field] | null }>;
export type JevMutation =
  | { kind: 'document'; canvasId: string; blockId: string; patch: JevDocumentPatch }
  | { kind: 'content'; canvasId: string; blockId: string; content: string; expectedContentHash: string; draftId: string }
  | { kind: 'task_create'; canvasId: string; task: Partial<CanvasTask> & { title: string; detail: string } }
  | { kind: 'task_update'; canvasId: string; taskId: string; expectedUpdatedAt: string; expectedRevision?: number; patch: Partial<CanvasTask> }
  | { kind: 'task_delete'; canvasId: string; taskId: string; expectedUpdatedAt: string; expectedRevision?: number }
  | { kind: 'move'; canvasId: string; blockId: string; targetCanvasId: string }
  | { kind: 'vocabulary'; operation: string; term: JevVocabularyTerm; previousId?: string }
  | { kind: 'derived'; blockId?: string; values: JevValues };
export interface JevVocabularyTerm {
  id: string;
  kind: 'group' | 'label' | 'entity';
  name: string;
  parentId?: string;
  groupKey?: string;
  definition: string;
  aliases: string[];
  state: 'candidate' | 'active' | 'retired';
  version: number;
  members: Array<{ canvasId: string; blockId: string }>;
}
export interface JevProposal {
  /** Set by the server when a reviewer changes the proposed mutation. */
  reviewerEdited?: boolean;
  automaticHoldReason?: string;
  decisionConfidences?: number[];
  id: string;
  jobId: string;
  action: JevAction;
  title: string;
  explanation: string;
  confidence?: number;
  evidence: JevPassage[];
  sources: JevSourceSnapshot[];
  mutation: JevMutation;
  state: 'pending' | 'applied' | 'dismissed' | 'suppressed' | 'stale';
  createdAt: string;
  receiptId?: string;
}
export interface JevJob {
  questionVersion?: string;
  id: string;
  request: JevActionRequest;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  sources: JevSourceSnapshot[];
  result?: JevValues;
  error?: string;
  proposalIds: string[];
}
export interface JevReceipt {
  automatic?: boolean;
  id: string;
  proposalId: string;
  action: JevAction;
  createdAt: string;
  actor: string;
  before: JevMutation;
  after: JevMutation;
  sourcesAfter: JevSourceSnapshot[];
  state: 'applied' | 'undone';
}
export interface JevWorkspaceState {
  commandPlans?: JevCommandPlan[];
  schemaVersion: 1;
  revision: number;
  settings: JevSettings;
  jobs: JevJob[];
  proposals: JevProposal[];
  receipts: JevReceipt[];
  vocabulary: JevVocabularyTerm[];
  profiles: Record<string, JevValues>;
  suppressions: string[];
  prepared: Array<{ id: string; proposal: JevProposal; before: JevMutation; after: JevMutation }>;
}
export interface JevCommandStep {
  id: string;
  request: JevActionRequest;
  dependsOn: string[];
  jobId?: string;
  state: 'pending' | 'running' | 'completed';
}
export interface JevCommandPlan {
  id: string;
  parentJobId?: string;
  recipe?: 'organize' | 'tasks' | 'connections';
  workspaceId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  steps: JevCommandStep[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface JevEvaluation {
  result: JevValues;
  proposals: Array<Omit<JevProposal, 'id' | 'jobId' | 'state' | 'createdAt'>>;
}
export type JevRelation = LinkRelation;
