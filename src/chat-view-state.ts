import type { AnswerCanvasResult } from '../shared/answer-canvas';
import { chatScopeOptions } from './chat-context';
import { chatSuggestions } from './chat-suggestions';
import { activeToolState } from './chat-turn-state';
import type { AIElementsChatProps } from './chat-types';
import { type SymbiState } from './SymbiAvatar';

import type { ChatState } from './chat-state';
export function chatViewState(props: AIElementsChatProps, state: ChatState) {
  const { canvasId, canvas, viewContext, answerTurns } = props;
  const { turns, scope } = state;
  const latestCanvasTurn = answerTurns.at(-1);
  const lastAnswerCanvas: AnswerCanvasResult | null = latestCanvasTurn?.sources.length ? {
    canvasId, query: latestCanvasTurn.query, selection: latestCanvasTurn.selection ?? 'local', sources: latestCanvasTurn.sources,
  } : null;
  const scopes = chatScopeOptions(canvas, viewContext, answerTurns);
  const activeScope = scopes.find(option => option.id === scope) ?? scopes[0];
  const suggestions = chatSuggestions(canvas, activeScope.context, lastAnswerCanvas);
  const avatarState = avatarForState(state);
  const latestId = turns.at(-1)?.id;
  return { scopes, activeScope, suggestions, avatarState, latestId };
}

function avatarForState(state: ChatState): SymbiState {
  if (state.error) return 'error';
  if (state.connection === 'checking') return 'checking';
  if (state.status === 'ready') return readyAvatar(state);
  if (state.status === 'submitted') return 'listening';
  const turn = state.turns.at(-1);
  return activeToolState(turn) ?? runningAvatar(state);
}
function readyAvatar(state: ChatState): SymbiState {
  if (state.turns.some(turn => turn.proposalState === 'applying')) return 'writing';
  const latest = state.turns.at(-1);
  if (latest?.proposalError) return 'error';
  if (latest?.proposal && latest.proposalState === 'pending') return 'asking';
  return state.justFinished ? 'done' : 'idle';
}
function runningAvatar(state: ChatState): SymbiState {
  return state.turns.at(-1)?.content ? 'speaking' : 'thinking';
}
