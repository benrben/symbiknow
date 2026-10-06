import { useCanvasData } from './app-canvas-data';
import { useChatCanvasActions } from './app-chat-actions';
import { useDocumentActions } from './app-documents';
import { useIntakeActions } from './app-intake';
import { useCanvasNavigationActions } from './app-navigation';
import { useResearchSession } from './app-research';
import { useCanvasSearch } from './app-search';
import { useAppState } from './app-state';
import { useWorkspaceActions } from './app-workspaces';

export function useAppModel() {
  const state = useAppState();
  const data = useCanvasData(state);
  const navigation = useCanvasNavigationActions(state);
  const documents = useDocumentActions(state, data, navigation);
  const research = useResearchSession(state);
  const workspace = useWorkspaceActions(state, data, documents, research);
  const intake = useIntakeActions(state, data, navigation, documents);
  const chatCanvas = useChatCanvasActions(state, data);
  const search = useCanvasSearch(state, navigation, documents);

  const {
    workspaces, canvasId, setCanvasId, canvas, crossLinkLabels, loading, error, setError, dialog, setDialog,
    draftName, setDraftName, canvasToDelete, workspaceToDelete, draftBlock, setDraftBlock, busy, settings,
    setSettings, showChat, setShowChat, documentAssistantWidth, chatSession, chatHasHistory, setChatHasHistory,
    assistantView, setAssistantView, activeInvestigation, setActiveInvestigation,
    investigationOpenRequest, setInvestigationOpenRequest, symbiState, setSymbiState, authRequired, draftLock, searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchHits,
    searching, searchResultQuery, searchError, setSearchRetry, activeSearchId, browseGroupsOpen, setBrowseGroupsOpen, chatPromptRequest, assistantFocusRequest, answerTurns, researchState,
    researchSaveCount, answerCanvasOpen, setAnswerCanvasOpen, researchActionRequest, researchLayout,
    setResearchLayout, answerCanvasViewFocus, setAnswerCanvasViewFocus, selectedBlockIds, visibleBlockIds,
    setVisibleBlockIds, canvasViewFocus, setCanvasViewFocus, viewportRequest,
    journey, focusRequest, setFocusRequest, groupFocusRequest, readerId, sourceFocus, versionBlockId, versionRevision,
    uploadRef,
  } = state;
  const { refreshAfterVersionChange, loadCanvas, signIn, retryConnection } = data;
  const {
    navigateTo, selectCanvas, showBlockOnCanvas, navigateFromChat, returnFromChatNavigation, openDocumentAssistant,
    updateDocumentAssistantWidth, openReader, openCrossLink, showReaderDocument, closeReader, openResearchSource,
    selectedOnCanvas,
  } = navigation;
  const {
    openNewBlock, openBlock, takeOverLock, moveBlocks, openVersionHistory, openActivityHistory, saveBlock,
    updateBlock, deleteCanvasBlock, deleteBlock, importEditedFile, saveSettings, openNamedDialog,
  } = documents;
  const {
    summarizeResearchSelection, summarizeCurrentResearch, requestResearchAction, addAnswerSources, updateAnswerText,
    applyResearchPatch, settleAnswerTurn, newChat, restoreResearchSnapshot, recheckAnswer,
    saveResearchCanvas, changeResearchEdits, undoResearchEdit,
  } = research;
  const { requestDeleteCanvas, requestDeleteWorkspace, deleteWorkspace, deleteCanvas, createNamed } = workspace;
  const { uploadFiles } = intake;
  const { refreshCanvasAfterChat, undoAgentCreatedBlock, undoAgentEditedBlock, summarizeSelection } = chatCanvas;
  const { selectSearchHit, revealSearchHit, openSearchEvidence, searchCurrentContentHashes } = search;

  return {
    workspaces, canvasId, setCanvasId, selectCanvas, canvas, crossLinkLabels, loading, error, setError, readerId,
    sourceFocus, openReader, openCrossLink, showReaderDocument, closeReader, openResearchSource, versionBlockId, versionRevision, dialog, setDialog, draftName, setDraftName, canvasToDelete, requestDeleteCanvas,
    deleteCanvas, workspaceToDelete, requestDeleteWorkspace, deleteWorkspace, draftBlock, setDraftBlock, draftLock,
    takeOverLock, busy, settings, setSettings, showChat, setShowChat, documentAssistantWidth,
    updateDocumentAssistantWidth, chatSession, newChat, chatHasHistory, setChatHasHistory, assistantView,
    setAssistantView, activeInvestigation, setActiveInvestigation,
    investigationOpenRequest, setInvestigationOpenRequest, assistantFocusRequest, openDocumentAssistant, symbiState,
    setSymbiState, searchOpen, authRequired, signIn, focusRequest,
    setFocusRequest, groupFocusRequest, showBlockOnCanvas, navigateFromChat, returnFromChatNavigation, activeSearchId,
    setSearchOpen, searchQuery, setSearchQuery, searchHits, searching, searchResultQuery,
    searchError, searchCurrentContentHashes, retrySearch: () => setSearchRetry(value => value + 1), uploadRef,
    browseGroupsOpen, setBrowseGroupsOpen, chatPromptRequest, viewportRequest, answerTurns, answerCanvasOpen, setAnswerCanvasOpen,
    restoreResearchSnapshot, answerCanvasViewFocus, setAnswerCanvasViewFocus, researchLayout, setResearchLayout,
    saveResearchCanvas, researchState, changeResearchEdits, undoResearchEdit, researchSaveCount,
    researchActionRequest, requestResearchAction, summarizeCurrentResearch, addAnswerSources, applyResearchPatch,
    updateAnswerText, settleAnswerTurn, recheckAnswer, selectedBlockIds, visibleBlockIds,
    setVisibleBlockIds, canvasViewFocus, setCanvasViewFocus, journey, navigateTo,
    selectedOnCanvas, summarizeSelection, summarizeResearchSelection, updateBlock, deleteCanvasBlock, moveBlocks,
    openBlock, openVersionHistory, openActivityHistory, openNewBlock, openNamedDialog, saveBlock, deleteBlock,
    createNamed, uploadFiles, importEditedFile, saveSettings, refreshCanvasAfterChat, undoAgentCreatedBlock,
    undoAgentEditedBlock, retryConnection, selectSearchHit, revealSearchHit, openSearchEvidence, refreshAfterVersionChange,
    loadCanvas,
  };
}

export type AppModel = ReturnType<typeof useAppModel>;
