import { useRef, useState } from 'react';
import { type ChatScope } from './chat-context';
import { restoredTurns } from './chat-turn-state';
import type { ChatStatus, DisplayTurn } from './chat-types';
import { type InvestigationResearchSnapshot } from './SavedInvestigations';

export function useChatState() {
  const [input, setInput] = useState(() => {
    try { return window.sessionStorage.getItem('symbiknow:chat-draft') ?? ''; }
    catch { return ''; }
  });
  const [turns, setTurns] = useState<DisplayTurn[]>(restoredTurns);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [error, setError] = useState('');
  const [justFinished, setJustFinished] = useState(false);
  const [scope, setScope] = useState<ChatScope>('view');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [undoingBlockId, setUndoingBlockId] = useState<string | null>(null);
  const [connection, setConnection] = useState<'online' | 'checking' | 'restored'>('online');
  const [previousConversation, setPreviousConversation] = useState<DisplayTurn[] | null>(null);
  const [previousResearch, setPreviousResearch] = useState<InvestigationResearchSnapshot | undefined>();
  const [savedSourceOpened, setSavedSourceOpened] = useState(false);
  const turnsRef = useRef<DisplayTurn[]>(turns);
  const activeRef = useRef<AbortController | null>(null);
  const nextId = useRef(Math.max(0, ...turns.map(turn => turn.id)));
  const nextActivityId = useRef(0);
  const lastPromptSequence = useRef<number | null>(null);
  const pendingPrompts = useRef<Array<{ text: string; sequence: number }>>([]);
  const settingsRequested = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function commit(next: DisplayTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }
  function cancelConversation() {
    activeRef.current?.abort();
    activeRef.current = null;
    pendingPrompts.current = [];
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = null;
    setJustFinished(false);
    setStatus('ready');
  }
  return {
    input, setInput, turns, setTurns, status, setStatus, error, setError, justFinished, setJustFinished, scope,
    setScope, scopeOpen, setScopeOpen, undoingBlockId, setUndoingBlockId, connection, setConnection,
    previousConversation, setPreviousConversation, previousResearch, setPreviousResearch, savedSourceOpened,
    setSavedSourceOpened, turnsRef, activeRef, nextId, nextActivityId, lastPromptSequence, pendingPrompts,
    settingsRequested, finishTimer, commit, cancelConversation,
  };
}
export type ChatState = ReturnType<typeof useChatState>;
