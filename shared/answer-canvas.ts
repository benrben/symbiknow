import type { BlockKind } from './types.js';
import type { EvidenceReference } from './evidence.js';

export interface ChatViewContext {
  selectedBlockIds: string[];
  visibleBlockIds?: string[];
  viewMode?: 'overview' | 'titles' | 'documents' | 'answer';
  readerBlockId?: string;
  editingBlockId?: string;
  editorHasUnsavedChanges?: boolean;
  editorDraft?: { title: string; kind: BlockKind; content: string; truncated?: boolean };
  focusBlockId?: string;
  searchQuery?: string;
  viewport?: { x: number; y: number; zoom: number };
  answerSourceIds?: string[];
  activeGroup?: string;
  visibleGroups?: string[];
  answerFocus?: {
    level: 'big-picture' | 'answers' | 'sources';
    visibleQuestions: string[];
    visibleBlockTitles?: string[];
    visibleSourceIds: string[];
    focusedQuestion?: string;
    focusedBlockTitle?: string;
    focusedSourceId?: string;
  };
}

export interface CanvasViewFocus {
  level: 'overview' | 'groups' | 'subgroups' | 'documents';
  activeGroup?: string;
  visibleGroups: string[];
}

export interface AnswerCanvasViewFocus {
  level: 'big-picture' | 'answers' | 'sources';
  visibleAnswerIds: number[];
  visibleBlockIds?: string[];
  visibleSourceKeys: string[];
  selectedAnswerId?: number;
  selectedBlockId?: string;
  selectedSourceKey?: string;
}

export type CanvasNavigationTarget =
  | { kind: 'document'; canvasId: string; blockId: string; title: string; excerpt?: string; contentHash?: string }
  | { kind: 'group'; canvasId: string; group: string; title: string };

export interface AnswerSource {
  canvasId: string;
  canvasName: string;
  blockId: string;
  title: string;
  excerpt: string;
  relevance: number;
  contentHash?: string;
  evidence?: EvidenceReference;
}

export interface AnswerCanvasResult {
  query: string;
  canvasId: string;
  selection: 'jev' | 'local';
  sources: AnswerSource[];
  layout?: ResearchLayout;
  surface?: 'chat' | 'canvas' | 'clarify';
}

export interface ResearchSurfaceChoice {
  question: string;
  options: Array<{ label: string; detail: string; prompt: string }>;
}

export type ResearchLayout = 'roadmap' | 'kanban' | 'architecture' | 'mindmap';

export interface ResearchCanvasBlock {
  id: string;
  type: 'text' | 'diagram' | 'task' | 'section';
  kind?: BlockKind | 'html';
  title: string;
  content: string;
  sourceIds: string[];
  lane?: string;
}

export interface ResearchCanvasEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ResearchCanvasPatch {
  query: string;
  layout?: ResearchLayout;
  blocks: ResearchCanvasBlock[];
  edges: ResearchCanvasEdge[];
}

export interface AnswerCanvasTurn {
  id: number;
  query: string;
  answer: string;
  sources: AnswerSource[];
  selection?: 'jev' | 'local';
  status: 'working' | 'complete' | 'stopped';
  patch?: ResearchCanvasPatch;
}
