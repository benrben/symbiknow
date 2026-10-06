import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import type { ResearchCanvasEdits } from './research-edits';
export type InvestigationMessage = { role: 'user' | 'assistant'; content: string };
export type InvestigationSourceRef = { canvasId: string; blockId: string; contentHash?: string; revisionId?: string; excerpt?: string };
export type InvestigationSourceChange = { canvasId: string; blockId: string; oldHash?: string; currentHash?: string };
export type InvestigationProposalRef = { kind: 'chat' | 'jev'; id: string; status?: string };
export type InvestigationResearchSnapshot = { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout };
export type InvestigationRecord = {
  id: string; workspaceId: string; canvasId?: string; title: string; visibility: 'private' | 'shared';
  question?: string; messages: InvestigationMessage[]; sourceRefs: InvestigationSourceRef[]; proposalRefs: InvestigationProposalRef[];
  researchSnapshot?: InvestigationResearchSnapshot;
  revision: number; createdAt: string; updatedAt: string
};
export type InvestigationSummary = Pick<InvestigationRecord, 'id' | 'workspaceId' | 'canvasId' | 'title' | 'visibility' | 'question' | 'revision' | 'createdAt' | 'updatedAt'>
  & { messageCount: number; sourceCount: number; proposalCount: number };
export type SavedResult = { investigation: InvestigationRecord; accessKey?: string };
export type SavedInvestigationsProps = {
  workspaceId: string; canvasId: string; messages: InvestigationMessage[];
  sourceRefs: InvestigationSourceRef[]; proposalRefs: InvestigationProposalRef[]; researchSnapshot?: InvestigationResearchSnapshot;
  onOpen: (record: InvestigationRecord) => void;
  onSaved?: (record: InvestigationRecord) => void;
  onClearSelection?: () => void;
  openRequest?: { id: string; sequence: number };
  onOpenSource?: (ref: InvestigationSourceRef) => void;
  onOpenProposal?: (ref: InvestigationProposalRef, record: InvestigationRecord) => Promise<void>;
  onRecheck?: (record: InvestigationRecord, changedSources: InvestigationSourceChange[]) => void
};

export type SourceCheck = InvestigationSourceChange & {
  title: string; savedExcerpt?: string; currentExcerpt?: string;
  state: 'current' | 'changed' | 'missing' | 'unknown'
};
