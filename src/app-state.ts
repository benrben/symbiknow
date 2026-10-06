import { useCallback, useRef, useState, type SetStateAction } from 'react';
import type { AnswerCanvasTurn, AnswerCanvasViewFocus, CanvasNavigationTarget, CanvasViewFocus, ResearchLayout } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument, ChatSettings, SearchHit, WorkspaceSummary } from '../shared/types';
import { initialDraft, type BlockDraft, type Dialog } from './app-model-helpers';
import { defaultSettings, restoredResearch } from './app-state-helpers';
import { type ResearchCanvasEdits } from './research-edits';
import { type SymbiState } from './SymbiAvatar';
import { useCanvasJourney, type CanvasPlace, type CanvasViewport } from './useCanvasJourney';

export type AssistantView = 'chat' | 'reflex';
export type ResearchActionRequest = { kind: 'add' | 'search' | 'groups' | 'upload'; sequence: number; files?: File[] };

function initialDocumentAssistantWidth() {
  const fallback = Math.max(500, Math.round(window.innerWidth * .5));
  try {
    const saved = Number(window.localStorage.getItem('symbiknow.assistant.document-width'));
    return Number.isFinite(saved) && saved >= 320 ? saved : fallback;
  } catch (reason) {
    console.warn('Document assistant width cannot be restored; using the default.', reason);
    return fallback;
  }
}

export function useAppState() {
  const [restoredSession] = useState(restoredResearch);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [canvasId, setCanvasId] = useState('');
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [crossLinkLabels, setCrossLinkLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialogState] = useState<Dialog>(null);
  const dialogVersion = useRef(0);
  const navigationVersion = useRef(0);
  const setDialog = useCallback((next: SetStateAction<Dialog>) => {
    dialogVersion.current++;
    setDialogState(next);
  }, []);
  const [draftName, setDraftName] = useState('');
  const [canvasToDelete, setCanvasToDelete] = useState<{ id: string; name: string; workspaceId: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceSummary | null>(null);
  const [draftBlock, setDraftBlock] = useState<BlockDraft>(initialDraft);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(defaultSettings);
  const [showChat, setShowChat] = useState(() => !window.matchMedia?.('(max-width: 620px)').matches);
  const [documentAssistantWidth, setDocumentAssistantWidth] = useState(initialDocumentAssistantWidth);
  const [chatSession, setChatSession] = useState(0);
  const [chatHasHistory, setChatHasHistory] = useState(false);
  const [assistantView, setAssistantView] = useState<AssistantView>('chat');
  const [activeInvestigation, setActiveInvestigation] = useState<{ id: string; canvasId: string }>();
  const [investigationOpenRequest, setInvestigationOpenRequest] = useState<{ id: string; sequence: number }>();
  const [symbiState, setSymbiState] = useState<SymbiState>('idle');
  const [authRequired, setAuthRequired] = useState(false);
  const [draftLock, setDraftLock] = useState<CanvasBlock['lock']>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchResultQuery, setSearchResultQuery] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const [activeSearchId, setActiveSearchId] = useState('');
  const [browseGroupsOpen, setBrowseGroupsOpen] = useState(false);
  const [chatPromptRequest, setChatPromptRequest] = useState<{ text: string; sequence: number }>();
  const [assistantFocusRequest, setAssistantFocusRequest] = useState(0);
  const [answerTurns, setAnswerTurns] = useState<AnswerCanvasTurn[]>(restoredSession.turns);
  const [researchState, setResearchState] = useState<{ edits: ResearchCanvasEdits; history: ResearchCanvasEdits[] }>(() => ({ edits: restoredSession.edits, history: [] }));
  const [researchSaveCount, setResearchSaveCount] = useState(0);
  const [answerCanvasOpen, setAnswerCanvasOpen] = useState(false);
  const [researchActionRequest, setResearchActionRequest] = useState<ResearchActionRequest>();
  const [researchLayout, setResearchLayout] = useState<ResearchLayout>(restoredSession.layout);
  const [answerCanvasViewFocus, setAnswerCanvasViewFocus] = useState<AnswerCanvasViewFocus>({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [visibleBlockIds, setVisibleBlockIds] = useState<string[]>([]);
  const [canvasViewFocus, setCanvasViewFocus] = useState<CanvasViewFocus>({ level: 'documents', visibleGroups: [] });
  const [viewportRequest, setViewportRequest] = useState<(CanvasViewport & { sequence: number })>();
  const journey = useCanvasJourney();
  const [focusRequest, setFocusRequest] = useState<{ canvasId: string; blockId: string; title: string; sequence: number } | null>(null);
  const [groupFocusRequest, setGroupFocusRequest] = useState<{ canvasId: string; group: string; sequence: number } | null>(null);
  const [readerId, setReaderId] = useState('');
  const [sourceFocus, setSourceFocus] = useState<Extract<CanvasNavigationTarget, { kind: 'document' }> | null>(null);
  const researchSourceReturn = useRef(false);
  const [versionBlockId, setVersionBlockId] = useState('');
  const [versionRevision, setVersionRevision] = useState<string>();
  const uploadRef = useRef<HTMLInputElement>(null);
  const canvasLoadVersions = useRef(new Map<string, number>());
  const lastInteraction = useRef(Date.now());
  const activeCanvasId = useRef(canvasId);
  activeCanvasId.current = canvasId;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const preferredWorkspaceId = useRef('');
  const dialogRef = useRef<Dialog>(dialog);
  dialogRef.current = dialog;
  const chatReturn = useRef<{ place: CanvasPlace; research: boolean } | null>(null);
  const [session, setSession] = useState(0);
  return {
    workspaces, setWorkspaces, canvasId, setCanvasId, canvas, setCanvas, crossLinkLabels, setCrossLinkLabels, loading,
    setLoading, error, setError, dialog, dialogVersion, navigationVersion, setDialog, draftName, setDraftName,
    canvasToDelete, setCanvasToDelete, workspaceToDelete, setWorkspaceToDelete, draftBlock, setDraftBlock, busy,
    setBusy, settings, setSettings, showChat, setShowChat, documentAssistantWidth, setDocumentAssistantWidth,
    chatSession, setChatSession, chatHasHistory, setChatHasHistory, assistantView, setAssistantView, activeInvestigation, setActiveInvestigation, investigationOpenRequest,
    setInvestigationOpenRequest, symbiState, setSymbiState, authRequired,
    setAuthRequired, draftLock, setDraftLock, searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchHits,
    setSearchHits, searching, setSearching, searchResultQuery,
    setSearchResultQuery, searchError, setSearchError, searchRetry, setSearchRetry, activeSearchId, setActiveSearchId,
    browseGroupsOpen, setBrowseGroupsOpen, chatPromptRequest, setChatPromptRequest,
    assistantFocusRequest, setAssistantFocusRequest, answerTurns, setAnswerTurns, researchState, setResearchState,
    researchSaveCount, setResearchSaveCount, answerCanvasOpen, setAnswerCanvasOpen, researchActionRequest,
    setResearchActionRequest, researchLayout, setResearchLayout, answerCanvasViewFocus, setAnswerCanvasViewFocus,
    selectedBlockIds, setSelectedBlockIds, visibleBlockIds, setVisibleBlockIds, canvasViewFocus, setCanvasViewFocus,
    viewportRequest, setViewportRequest, journey, focusRequest,
    setFocusRequest, groupFocusRequest, setGroupFocusRequest, readerId, setReaderId, sourceFocus, setSourceFocus,
    researchSourceReturn, versionBlockId, setVersionBlockId, versionRevision, setVersionRevision, uploadRef,
    canvasLoadVersions, lastInteraction, activeCanvasId, workspacesRef,
    preferredWorkspaceId, dialogRef, chatReturn, session, setSession,
  };
}

export type AppState = ReturnType<typeof useAppState>;
