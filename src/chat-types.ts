import type { ChatProposal, ChatProposalReceipt, ChatProposalUndoReceipt, ChatTurn } from './chatStream';
import type { InvestigationResearchSnapshot } from './SavedInvestigations';
import type { AnswerCanvasResult, AnswerCanvasTurn, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch, ResearchLayout } from '../shared/answer-canvas';
import type { ResearchCanvasEdits } from './research-edits';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { SymbiState } from './SymbiAvatar';
import type { CanvasChanges, CanvasEdit } from './canvas-changes';

export type AIElementsChatProps = {
  canvasId: string;
  canvas: CanvasDocument | null;
  viewContext: ChatViewContext;
  answerTurns: AnswerCanvasTurn[];
  researchEdits?: ResearchCanvasEdits;
  researchLayout?: ResearchLayout;
  hasApiKey: boolean;
  model: string;
  promptRequest?: { text: string; sequence: number };
  focusRequest?: number;
  investigationOpenRequest?: { id: string; sequence: number };
  onActiveInvestigationChange?: (reference?: { id: string; canvasId: string }) => void;
  onOpenSettings: () => void;
  onCanvasChanged: (canvasId: string, beforeBlocks: CanvasBlock[]) => Promise<CanvasChanges>;
  onShowBlock: (block: CanvasBlock, canvasId?: string) => void;
  onNavigate: (target: CanvasNavigationTarget) => void;
  onReturnNavigation: () => void;
  onUndoCreatedBlock: (canvasId: string, block: CanvasBlock) => Promise<void>;
  onUndoEditedBlock: (canvasId: string, edit: CanvasEdit) => Promise<void>;
  onCanvasSources: (id: number, result: AnswerCanvasResult) => void;
  onCanvasPatch: (id: number, patch: ResearchCanvasPatch) => void;
  onCanvasAnswer: (id: number, answer: string) => void;
  onCanvasTurnEnd: (id: number, status: 'complete' | 'stopped') => void;
  onRestoreResearch?: (snapshot?: InvestigationResearchSnapshot) => void;
  onOpenAnswerCanvas: () => void;
  onAvatarStateChange?: (state: SymbiState) => void;
  onHistoryChange?: (hasHistory: boolean) => void;
};

export type Activity = { key: number; type: 'thinking' | 'tool'; id?: string; name?: string; message: string; status: 'active' | 'complete' | 'stopped' };
export type DisplayTurn = ChatTurn & { id: number; activities: Activity[]; createdBlocks?: CanvasBlock[]; editedBlocks?: CanvasEdit[];
  createdCanvasId?: string; undoMessage?: string; undoError?: string;
  proposal?: ChatProposal; selectedProposalIds?: string[]; proposalState?: 'pending' | 'applying' | 'applied' | 'reverted' | 'expired' | 'failed';
  proposalReceipt?: ChatProposalReceipt; proposalUndoReceipt?: ChatProposalUndoReceipt; proposalError?: string;
  answerCanvas?: AnswerCanvasResult; researchPatch?: ResearchCanvasPatch;
  navigation?: CanvasNavigationTarget };
export type ChatStatus = 'ready' | 'submitted' | 'streaming';

