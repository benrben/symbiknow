import type { CanvasBlock } from '../shared/types.js';

export type ChatProposalChange = {
  id: string; type: 'create' | 'edit' | 'delete' | 'move' | 'link'; blockId: string; title: string;
  before: CanvasBlock | null; after: CanvasBlock | null; expectedContentHash: string | null; expectedStateHash: string | null;
  canApply: boolean;
};
export type ChatProposal = { id: string; canvasId: string; status: 'pending'; expiresAt: string; changes: ChatProposalChange[] };
export type ChatProposalReceipt = { id: string; status: 'applied' | 'partial'; applied: string[]; skipped: { id: string; reason: string }[];
  createdBlockIds: Record<string, string>; documents: { id: string; before: CanvasBlock | null; after: CanvasBlock | null }[] };

export type PendingState = { version: 1; kind: 'pending'; expires: number; proposal: ChatProposal };
export type AppliedState = { version: 1; kind: 'applied'; expires: number; canvasId: string; receipt: ChatProposalReceipt };
export type StoredState = PendingState | AppliedState;
