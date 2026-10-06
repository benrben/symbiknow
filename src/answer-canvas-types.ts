import type { AnswerCanvasTurn, AnswerCanvasViewFocus, AnswerSource, ResearchLayout } from '../shared/answer-canvas';
import type { BlockKind, CanvasBlock } from '../shared/types';
import type { ResearchCanvasEdits } from './research-edits';
import type { Theme } from './theme';

export type AnswerCanvasProps = {
  turns: AnswerCanvasTurn[];
  layout: ResearchLayout;
  theme: Theme;
  edits: ResearchCanvasEdits;
  canUndo: boolean;
  historyCount: number;
  hasSavedCopy: boolean;
  actionRequest?: { kind: 'add' | 'search' | 'groups' | 'upload'; sequence: number; files?: File[] };
  onEditsChange: (edits: ResearchCanvasEdits) => void;
  onUndo: () => void;
  onLayoutChange: (layout: ResearchLayout) => void;
  onSave: (layout: ResearchLayout) => Promise<{ id: string; name: string }>;
  onOpenSavedCanvas: (canvasId: string, name: string) => void;
  onClose: () => void;
  onOpenSource: (source: AnswerSource) => void;
  onRecheck: () => void;
  onAskSelection?: (blocks: CanvasBlock[]) => void;
  onViewFocusChange?: (focus: AnswerCanvasViewFocus) => void;
};

export type AnswerDraft = { id?: string; title: string; content: string; kind: BlockKind };
