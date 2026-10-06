import { resetAssistant, updatedActivity, updatedAssistant } from './chat-turn-state';
import type { AIElementsChatProps } from './chat-types';
import type { Handlers } from './chat-stream-types';

import type { ChatState } from './chat-state';
export function createRunEvents(props: AIElementsChatProps, state: ChatState, assistantId: number, isActive: () => boolean): Handlers {
  const { onNavigate, onCanvasSources, onCanvasPatch, onCanvasAnswer } = props;
  const { setStatus, turnsRef, nextActivityId, commit } = state;

  return {

    onChunk: chunk => {
      if (!isActive()) return;
      const next = updatedAssistant(turnsRef.current, assistantId, chunk);
      commit(next);
      onCanvasAnswer(assistantId, next.find(turn => turn.id === assistantId)?.content ?? '');
      setStatus('streaming');
    },
    onStep: step => {
      if (!isActive()) return;
      const next = updatedActivity(turnsRef.current, assistantId, step, ++nextActivityId.current);
      if (next !== turnsRef.current) commit(next);
      setStatus('streaming');
    },
    onReset: () => {
      if (!isActive()) return;
      commit(resetAssistant(turnsRef.current, assistantId, ++nextActivityId.current));
      onCanvasAnswer(assistantId, '');
    },
    onAnswerCanvas: answer => {
      if (!isActive()) return;
      commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, answerCanvas: answer } : turn));
      onCanvasSources(assistantId, answer);
    },
    onNavigation: target => {
      if (!isActive()) return;
      commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, navigation: target } : turn));
      onNavigate(target);
    },
    onResearchPatch: patch => {
      if (!isActive()) return;
      commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, researchPatch: patch } : turn));
      onCanvasPatch(assistantId, patch);
    },
    onProposal: proposal => {
      if (isActive()) commit(turnsRef.current.map(turn => turn.id === assistantId
        ? { ...turn, proposal, selectedProposalIds: proposal.changes.filter(change => change.canApply !== false).map(change => change.id), proposalState: 'pending' } : turn));
    },
  };
}
