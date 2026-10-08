import type { AnswerCanvasResult, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AgentStep = {
  type: 'thinking' | 'tool_start' | 'tool_end';
  id?: string;
  name?: string;
  message: string;
};

export type ChatProposalChange = { id: string; type: 'create' | 'edit' | 'delete' | 'move' | 'link'; blockId: string; title: string;
  before: CanvasBlock | null; after: CanvasBlock | null; expectedContentHash: string | null; expectedStateHash?: string | null; canApply?: boolean };
export type ChatProposal = { id: string; canvasId: string; changes: ChatProposalChange[]; status: 'pending'; expiresAt?: string };
export type ChatProposalReceipt = { id: string; status: 'applied' | 'partial'; applied: string[];
  skipped: Array<{ id: string; reason: string }>; createdBlockIds: Record<string, string>;
  documents?: Array<{ id: string; before: CanvasBlock | null; after: CanvasBlock | null }> };
export type ChatProposalUndoReceipt = { id: string; status: 'reverted' | 'partial'; reverted: string[]; skipped: Array<{ id: string; reason: string }> };

export type StreamOptions = {
  canvasId: string;
  conversationId?: string;
  messages: ChatTurn[];
  viewContext?: ChatViewContext;
  signal: AbortSignal;
  onChunk: (content: string) => void;
  onStep?: (step: AgentStep) => void;
  /** The text streamed so far was a note before a tool call, not the answer. */
  onReset?: () => void;
  onAnswerCanvas?: (canvas: AnswerCanvasResult) => void;
  onNavigation?: (target: CanvasNavigationTarget) => void;
  onResearchPatch?: (patch: ResearchCanvasPatch) => void;
  onProposal?: (proposal: ChatProposal) => void;
  fetcher?: typeof fetch;
};

export type Handlers = Pick<StreamOptions, 'onChunk' | 'onStep' | 'onReset' | 'onAnswerCanvas' | 'onNavigation' | 'onResearchPatch' | 'onProposal'>;
