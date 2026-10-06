import type { CanvasBlock } from '../shared/types';
import type { SymbiState } from './SymbiAvatar';
import type { CanvasEdit } from './canvas-changes';
import type { ChatStatus, DisplayTurn } from './chat-types';

export type TurnMessageProps = {
  turn: DisplayTurn; status: ChatStatus; latestId?: number; avatarState: SymbiState; undoingBlockId: string | null;
  onShowBlock: (block: CanvasBlock, canvasId?: string) => void;
  onOpenAnswerCanvas: () => void; onChooseSurface: (prompt: string) => void;
  onReturnNavigation: () => void; onUndoCreated: (turnId: number, block: CanvasBlock) => void;
  onUndoEdited: (turnId: number, edit: CanvasEdit) => void;
  onSelectProposal: (turnId: number, changeId: string, selected: boolean) => void;
  onApplyProposal: (turnId: number) => void;
  onUndoProposal: (turnId: number) => void;
  question?: string
};
