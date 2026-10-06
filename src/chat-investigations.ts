import { api } from './api';
import { finishActivity } from './chat-turn-state';
import type { Activity, AIElementsChatProps, DisplayTurn } from './chat-types';
import { type ChatProposal, type ChatProposalReceipt } from './chatStream';
import { type InvestigationProposalRef, type InvestigationRecord, type InvestigationSourceRef } from './SavedInvestigations';

import type { ChatState } from './chat-state';
export function useChatInvestigations(props: AIElementsChatProps, state: ChatState, submit: (text: string) => void) {
  const { canvasId, canvas, answerTurns, researchEdits, researchLayout, onActiveInvestigationChange, onNavigate, onRestoreResearch } = props;
  const {
    turns, setStatus, setError, setPreviousConversation, setPreviousResearch, setSavedSourceOpened, turnsRef, nextId,
    commit, cancelConversation,
  } = state;
  function openInvestigation(record: InvestigationRecord) {
    cancelConversation();
    if (turnsRef.current.some(turn => turn.content.trim()) || answerTurns.length) {
      setPreviousConversation(turnsRef.current.map(turn => ({ ...turn, activities: finishActivity(turn.activities, 'stopped') })));
      if (researchEdits && researchLayout) setPreviousResearch({ turns: answerTurns, edits: researchEdits, layout: researchLayout });
    }
    const next = record.messages.map(message => ({ ...message, id: ++nextId.current, activities: [] as Activity[] }));
    commit(next);
    onActiveInvestigationChange?.({ id: record.id, canvasId: record.canvasId ?? canvasId });
    onRestoreResearch?.(record.researchSnapshot);
    setError('');
    setStatus('ready');
  }
  function openInvestigationSource(source: InvestigationSourceRef) {
    setSavedSourceOpened(true);
    onNavigate({
      kind: 'document', canvasId: source.canvasId, blockId: source.blockId,
      title: canvas?.blocks.find(block => block.id === source.blockId)?.title ?? source.blockId,
      excerpt: source.excerpt, contentHash: source.contentHash
    });
  }
  async function openInvestigationProposal(reference: InvestigationProposalRef, record: InvestigationRecord) {
    if (reference.kind !== 'chat') throw new Error('This saved legacy proposal is no longer available.');
    const result = await api<ChatProposal | ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(reference.id)}`);
    const next = recoveredProposalTurn(result, record.canvasId ?? canvasId, ++nextId.current);
    commit([...turnsRef.current, next]);
  }
  function recheckInvestigation(record: InvestigationRecord, changedSources: Array<{
    canvasId: string; blockId: string;
    oldHash?: string; currentHash?: string
  }>) {
    const previousAnswer = [...record.messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
    const sourceChanges = changedSources.map(source => `${source.canvasId}/${source.blockId}: saved hash ${source.oldHash ?? 'unknown'}, current hash ${source.currentHash ?? 'missing'}`);
    submit(`Recheck this saved investigation against the current documents. Compare the earlier answer with what the changed sources now support. Explain which claims remain supported, which changed, and what is still uncertain. Do not edit documents.\n\nEarlier answer:\n${previousAnswer.slice(0, 12_000)}\n\nChanged sources:\n${sourceChanges.join('\n')}`);
  }
  const investigationSources = [...new Map(turns.flatMap(turn => [
    ...(turn.answerCanvas?.sources ?? []),
  ]).concat(answerTurns.flatMap(turn => turn.sources)).filter(source => source.canvasId && source.blockId).map(source => [`${source.canvasId}:${source.blockId}`, {
    canvasId: source.canvasId, blockId: source.blockId,
    ...(source.contentHash && /^[a-f0-9]{16}$/.test(source.contentHash) ? { contentHash: source.contentHash } : {}),
    ...(source.excerpt ? { excerpt: source.excerpt.slice(0, 2_000) } : {}),
  }]))].map(([, source]) => source);
  const investigationProposals = turns.flatMap(turn => turn.proposal ? [{
    kind: 'chat' as const, id: turn.proposal.id,
    status: turn.proposalState ?? 'pending'
  }] : []);
  return { openInvestigation, openInvestigationSource, openInvestigationProposal, recheckInvestigation, investigationSources, investigationProposals };
}

function recoveredProposalTurn(result: ChatProposal | ChatProposalReceipt, canvasId: string, id: number): DisplayTurn {
  if (result.status === 'pending') return {
    id, role: 'assistant', content: 'Recovered the saved proposal for review.', activities: [], proposal: result,
    selectedProposalIds: result.changes.filter(change => change.canApply !== false).map(change => change.id),
    proposalState: 'pending',
  };
  return {
    id, role: 'assistant', content: 'Recovered the saved proposal receipt and its document changes.', activities: [],
    proposal: { id: result.id, canvasId, status: 'pending', changes: (result.documents ?? []).map(receiptChange) },
    selectedProposalIds: [], proposalState: result.applied.length ? 'applied' : 'failed', proposalReceipt: result,
  };
}
function receiptChange(document: NonNullable<ChatProposalReceipt['documents']>[number]): ChatProposal['changes'][number] {
  return {
    id: document.id, blockId: document.id, title: document.after?.title ?? document.before?.title ?? document.id,
    type: document.before ? document.after ? 'edit' : 'delete' : 'create', before: document.before,
    after: document.after, expectedContentHash: null, canApply: false,
  };
}
