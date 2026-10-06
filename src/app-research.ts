import { useEffect } from 'react';
import type { AnswerCanvasResult, ResearchCanvasPatch, ResearchLayout } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument, WorkspaceSummary } from '../shared/types';
import type { AppState, ResearchActionRequest } from './app-state';
import { researchStorageKey } from './app-state-helpers';
import { chatHistoryKey } from './chat-history';
import { editedResearchGraph, emptyResearchEdits, type ResearchCanvasEdits } from './research-edits';
import { persistResearchCanvas, refreshResearchWorkspaces } from './research-save';
import type { InvestigationResearchSnapshot } from './SavedInvestigations';

function persistResearchSession(value: unknown): boolean {
  try {
    window.localStorage.setItem(researchStorageKey, JSON.stringify(value));
    return true;
  } catch {
    // Storage failure leaves the current session usable in React state.
    return false;
  }
}

function clearStoredConversation(): boolean {
  try {
    window.localStorage.removeItem(chatHistoryKey);
    window.localStorage.removeItem(researchStorageKey);
    return true;
  } catch {
    // The caller still clears the in-memory conversation when storage is unavailable.
    return false;
  }
}

function researchWorkspaceId(canvas: CanvasDocument | null, workspaces: WorkspaceSummary[]) {
  return canvas?.workspaceId ?? workspaces[0]?.id;
}

export function useResearchSession(state: AppState) {
  const {
    workspaces, setWorkspaces, canvas, setShowChat, setChatSession, setChatHasHistory, setAssistantView,
    setActiveInvestigation, setInvestigationOpenRequest, setSymbiState, setChatPromptRequest, answerTurns,
    setAnswerTurns, researchState, setResearchState, researchSaveCount, setResearchSaveCount, setAnswerCanvasOpen,
    setResearchActionRequest, researchLayout, setResearchLayout, setAnswerCanvasViewFocus,
  } = state;

  useEffect(() => {
    persistResearchSession({ turns: answerTurns.slice(-30), edits: researchState.edits, layout: researchLayout });
  }, [answerTurns, researchState.edits, researchLayout]);

  function summarizeResearchSelection(blocks: CanvasBlock[]) {
    setShowChat(true);
    setAssistantView('chat');
    const text = 'Summarize these research blocks and explain how they connect: '
      + blocks.map(block => block.title + ': ' + block.content.slice(0, 220)).join(' | ');
    setChatPromptRequest(current => ({ text, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function summarizeCurrentResearch() {
    const graph = editedResearchGraph(answerTurns, researchLayout, researchState.edits);
    summarizeResearchSelection(graph.blocks.map(block => ({
      id: block.id, title: block.title, file: '', kind: block.kind ?? 'markdown', content: block.content,
      x: block.x, y: block.y, width: block.width ?? 400, height: block.height ?? 290, links: [],
    })));
  }

  function requestResearchAction(kind: ResearchActionRequest['kind'], files?: File[]) {
    setResearchActionRequest(current => ({ kind, files, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function addAnswerSources(id: number, result: AnswerCanvasResult) {
    if (!answerTurns.length) {
      setAnswerCanvasOpen(true);
      if (result.layout) setResearchLayout(result.layout);
    }
    setAnswerTurns(current => {
      const existing = current.find(turn => turn.id === id);
      if (existing) return current.map(turn => turn.id === id ? { ...turn, query: result.query, sources: result.sources,
        selection: result.selection } : turn);
      return [...current, { id, query: result.query, answer: '', sources: result.sources,
        selection: result.selection, status: 'working' }];
    });
  }

  function updateAnswerText(id: number, answer: string) {
    setAnswerTurns(current => current.map(turn => turn.id === id ? { ...turn, answer } : turn));
  }

  function applyResearchPatch(id: number, patch: ResearchCanvasPatch) {
    if (!answerTurns.length) setAnswerCanvasOpen(true);
    if (patch.layout && !answerTurns.length) setResearchLayout(patch.layout);
    setAnswerTurns(current => {
      const existing = current.find(turn => turn.id === id);
      if (!existing) return [...current, { id, query: patch.query, answer: '', sources: [], status: 'working', patch }];
      return current.map(turn => turn.id === id ? { ...turn, patch: turn.patch ? {
        ...patch,
        blocks: [...new Map([...turn.patch.blocks, ...patch.blocks].map(block => [block.id, block])).values()],
        edges: [...new Map([...turn.patch.edges, ...patch.edges].map(edge => [`${edge.from}:${edge.to}`, edge])).values()],
      } : patch } : turn);
    });
  }

  function settleAnswerTurn(id: number, status: 'complete' | 'stopped') {
    setAnswerTurns(current => current.map(turn => turn.id === id ? { ...turn, status } : turn));
  }

  function newChat() {
    clearStoredConversation();
    setSymbiState('idle');
    setChatSession(value => value + 1);
    setChatPromptRequest(undefined);
    setChatHasHistory(false);
    setActiveInvestigation(undefined);
    setInvestigationOpenRequest(undefined);
    setAnswerTurns([]);
    setResearchState({ edits: emptyResearchEdits(), history: [] });
    setResearchSaveCount(0);
    setAnswerCanvasOpen(false);
    setResearchLayout('mindmap');
    setAnswerCanvasViewFocus({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  }

  function restoreResearchSnapshot(snapshot?: InvestigationResearchSnapshot) {
    const restored = snapshot ?? { turns: [], edits: emptyResearchEdits(), layout: 'mindmap' };
    setAnswerTurns(restored.turns.map(turn => ({ ...turn, status: turn.status === 'working' ? 'stopped' : turn.status })));
    setResearchState({ edits: restored.edits ?? emptyResearchEdits(), history: [] });
    setResearchLayout(restored.layout ?? 'mindmap');
    setAnswerCanvasViewFocus({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
    setAnswerCanvasOpen(Boolean(restored.turns.length));
  }

  function recheckAnswer() {
    if (!answerTurns.length) return;
    setShowChat(true);
    setAssistantView('chat');
    setChatPromptRequest(current => ({ text: 'What changed in the sources for this conversation, and which earlier answers need updating?',
      sequence: (current?.sequence ?? 0) + 1 }));
  }

  async function saveResearchCanvas(layout: ResearchLayout): Promise<{ id: string; name: string }> {
    const workspaceId = researchWorkspaceId(canvas, workspaces);
    if (!workspaceId || !answerTurns.length) throw new Error('Open a workspace and ask a research question first.');
    const graph = editedResearchGraph(answerTurns, layout, researchState.edits);
    const suffix = researchSaveCount ? ` (${researchSaveCount + 1})` : '';
    const name = `Research — ${answerTurns[0].query}`.slice(0, 80 - suffix.length) + suffix;
    const created = await persistResearchCanvas({ workspaceId, name, graph, workspaces });
    const refreshed = await refreshResearchWorkspaces(created);
    setWorkspaces(refreshed);
    setResearchSaveCount(current => current + 1);
    return { id: created.id, name };
  }

  function changeResearchEdits(edits: ResearchCanvasEdits) {
    setResearchState(current => ({ edits, history: [...current.history, current.edits].slice(-30) }));
  }

  function undoResearchEdit() {
    setResearchState(current => current.history.length ? {
      edits: current.history.at(-1)!, history: current.history.slice(0, -1),
    } : current);
  }

  return { summarizeResearchSelection, summarizeCurrentResearch, requestResearchAction, addAnswerSources, updateAnswerText, applyResearchPatch, settleAnswerTurn, newChat, restoreResearchSnapshot, recheckAnswer, saveResearchCanvas, changeResearchEdits, undoResearchEdit };
}

export type ResearchSessionActions = ReturnType<typeof useResearchSession>;
