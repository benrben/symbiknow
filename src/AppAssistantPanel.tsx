import { lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CanvasNavigationTarget } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import type { AppModel } from './app-model';
import type { AssistantView } from './app-state';
import { Icon } from './AppIcon';
import { type CanvasEdit } from './canvas-changes';
import { ResizableAssistant } from './ResizableAssistant';
import { SymbiAvatar, type SymbiState } from './SymbiAvatar';
import { useStableEvent } from './useStableEvent';
import { useAssistantContext } from './app-assistant-context';
import { useNewChatConfirmation } from './useNewChatConfirmation';
import { NewChatConfirmation } from './NewChatConfirmation';
import { JevPanel } from './JevPanel';
import { JevAvatar } from './JevAvatar';
import { useJevWorkspace, type JevWorkspaceModel } from './useJevWorkspace';
import { errorText } from './app-state-helpers';

const ChatView = lazy(() => import('./AIElementsChat').then(module => ({ default: memo(module.AIElementsChat) })));

export function AssistantPanel({ model }: { model: AppModel }) {
  const [visited, setVisited] = useState<AssistantView[]>([]);
  const [reflexSettingsRequest, setReflexSettingsRequest] = useState(0);
  const reflex = useJevWorkspace(model.canvas?.workspaceId ?? '', model.showChat && model.assistantView === 'reflex', () => model.loadCanvas(model.canvasId), model.canvasId);
  const loadReflexSources = useStableEvent(async () => {
    try { await model.loadCanvas(model.canvasId); }
    catch (failure) { model.setError(errorText(failure)); }
  });
  useEffect(() => {
    if (model.showChat && model.assistantView === 'reflex' && model.canvasId) void loadReflexSources();
  }, [model.showChat, model.assistantView, model.canvasId, loadReflexSources]);
  const openReflexSettings = useStableEvent(() => { model.setShowChat(true); model.setAssistantView('reflex'); setReflexSettingsRequest(current => current + 1); });
  useEffect(() => { window.addEventListener('symbiknow:open-jev', openReflexSettings); return () => window.removeEventListener('symbiknow:open-jev', openReflexSettings); }, [openReflexSettings]);
  const confirmation = useNewChatConfirmation(model);
  const newChatTriggerRef = useRef<HTMLButtonElement>(null);
  const hadNewChatPrompt = useRef(false);
  useEffect(() => {
    if (confirmation.open) hadNewChatPrompt.current = true;
    else if (hadNewChatPrompt.current) { hadNewChatPrompt.current = false; newChatTriggerRef.current?.focus(); }
  }, [confirmation.open]);
  useEffect(() => {
    if (model.showChat) setVisited(current => current.includes(model.assistantView) ? current : [...current, model.assistantView]);
  }, [model.showChat, model.assistantView]);
  const handlers = useAssistantHandlers(model);
  return <ResizableAssistant hidden={!model.showChat}
    documentWidth={model.dialog === 'block' || (!model.dialog && model.readerId) ? model.documentAssistantWidth : undefined}
    onDocumentWidthChange={model.updateDocumentAssistantWidth}>
    <AssistantHeader model={model} reflex={reflex} triggerRef={newChatTriggerRef} startNewChat={confirmation.start}/>
    <div className="assistant-tabs" role="tablist" aria-label="Assistant views">{(['chat', 'reflex'] as const).map(view =>
      <button key={view} role="tab" aria-selected={model.assistantView === view} onClick={() => model.setAssistantView(view)}>{view === 'chat' ? 'Chat' : 'Symbi Reflex'}</button>)}</div>
    <ChatContent model={model} visited={visited} handlers={handlers}/>

    <AssistantViewPane model={model} visited={visited} view="reflex"><JevPanel model={reflex} canvas={model.canvas} settingsRequest={reflexSettingsRequest} onAddSource={model.openNewBlock}
      onOpenDocument={model.openCrossLink} onShowCanvas={(canvasId, blockId) => model.showBlockOnCanvas(canvasId, blockId,
        model.canvas?.blocks.find(block => block.id === blockId)?.title ?? 'Organized source')} onOpenEvidence={evidence => model.navigateFromChat({ kind: 'document', canvasId: evidence.source.canvasId,
        blockId: evidence.source.blockId, title: model.canvas?.blocks.find(block => block.id === evidence.source.blockId)?.title ?? 'Source evidence',
        excerpt: evidence.quote, contentHash: evidence.source.contentHash, incarnation: evidence.source.incarnation,
        sourceGeneration: evidence.source.sourceGeneration, metadataRevision: evidence.source.metadataRevision,
        start: evidence.start, end: evidence.end, origin: 'Symbi Reflex' })}/></AssistantViewPane>
    <NewChatConfirmation canSave={model.answerTurns.length > 0} open={confirmation.open} saving={confirmation.saving} error={confirmation.error}
      onClose={confirmation.close} onDiscard={confirmation.discard} onSave={confirmation.save}/>
  </ResizableAssistant>;
}

function useAssistantHandlers(model: AppModel) {
  const openSettings = useStableEvent(() => model.setDialog('settings'));
  const canvasChanged = useStableEvent((canvasId: string, beforeBlocks: CanvasBlock[]) => model.refreshCanvasAfterChat(canvasId, beforeBlocks));
  const showChatBlock = useStableEvent((block: CanvasBlock, targetCanvasId?: string) => model.showBlockOnCanvas(targetCanvasId ?? model.canvasId, block.id, block.title));
  const navigateFromChat = useStableEvent((target: CanvasNavigationTarget) => model.navigateFromChat(target));
  const returnFromChatNavigation = useStableEvent(() => model.returnFromChatNavigation());
  const undoAgentCreatedBlock = useStableEvent((targetCanvasId: string, block: CanvasBlock) => model.undoAgentCreatedBlock(targetCanvasId, block));
  const undoAgentEditedBlock = useStableEvent((targetCanvasId: string, edit: CanvasEdit) => model.undoAgentEditedBlock(targetCanvasId, edit));
  return { openSettings, canvasChanged, showChatBlock, navigateFromChat, returnFromChatNavigation, undoAgentCreatedBlock, undoAgentEditedBlock };

}

type AssistantContentProps = { model: AppModel; visited: AssistantView[]; handlers: ReturnType<typeof useAssistantHandlers> };

function ChatContent({ model, visited, handlers }: AssistantContentProps) {
  const {
    openSettings, canvasChanged, showChatBlock, navigateFromChat, returnFromChatNavigation, undoAgentCreatedBlock,
    undoAgentEditedBlock,
  } = handlers;
  const viewContext = useAssistantContext(model);
  return <AssistantViewPane model={model} visited={visited} view="chat">{<Suspense fallback={<div className="assistant-view__loading">Opening chat…</div>}><ChatView key={model.chatSession} canvasId={model.canvasId} canvas={model.canvas} viewContext={viewContext} answerTurns={model.answerTurns} researchEdits={model.researchState.edits} researchLayout={model.researchLayout} investigationOpenRequest={model.investigationOpenRequest} onActiveInvestigationChange={model.setActiveInvestigation} hasApiKey={model.settings.hasApiKey} model={model.settings.model} promptRequest={model.chatPromptRequest} focusRequest={model.assistantFocusRequest} onOpenSettings={openSettings} onCanvasChanged={canvasChanged} onShowBlock={showChatBlock} onNavigate={navigateFromChat} onReturnNavigation={returnFromChatNavigation} onUndoCreatedBlock={undoAgentCreatedBlock} onUndoEditedBlock={undoAgentEditedBlock} onCanvasSources={model.addAnswerSources} onCanvasPatch={model.applyResearchPatch} onCanvasAnswer={model.updateAnswerText} onCanvasTurnEnd={model.settleAnswerTurn} onRestoreResearch={model.restoreResearchSnapshot} onOpenAnswerCanvas={() => model.setAnswerCanvasOpen(true)} onAvatarStateChange={model.setSymbiState} onHistoryChange={model.setChatHasHistory}/></Suspense>}</AssistantViewPane>;
}

function AssistantViewPane({ model, visited, view, children }: {
  model: AppModel; visited: AssistantView[]; view: AssistantView; children: ReactNode;
}) {
  const mounted = visited.includes(view) || (model.showChat && model.assistantView === view);
  return <div className="assistant-view" hidden={model.assistantView !== view}>{mounted && children}</div>;
}

/** Reflex works from a background queue, so its captions describe that queue rather than a live conversation. */
const reflexCaption: Partial<Record<SymbiState, string>> = {
  thinking: 'Actions queued in the background', resting: 'Organizing automatically', idle: 'Organizing automatically',
};

function AssistantHeader({ model, reflex, triggerRef, startNewChat }: {
  model: AppModel; reflex: JevWorkspaceModel; triggerRef: RefObject<HTMLButtonElement | null>; startNewChat: () => void;
}) {
  const visibleSymbiState = model.symbiState;
  const symbiCaption: Record<SymbiState, string> = {
    idle: 'Your guide to this canvas', thinking: 'Thinking it through…',
    searching: 'Searching documents…', reading: 'Reading the source…', working: 'Updating the canvas…',
    navigating: 'Opening the right place…', tooling: 'Working with a tool…', speaking: 'Putting the answer together…',
    done: 'Answer ready', error: 'Couldn’t finish — retry below',
    resting: 'Your guide to this canvas', moving: 'Opening the right place…',
    listening: 'Receiving your request…', talking: 'Putting the answer together…',
    writing: 'Preparing changes…', asking: 'Waiting for your decision…',
    connecting: 'Connecting documents…', organizing: 'Organizing the research canvas…',
    comparing: 'Comparing the evidence…', checking: 'Checking the connection…',
    summarizing: 'Preparing a summary…', paused: 'Paused', cancelled: 'Stopped', unavailable: 'Connection unavailable',
  };
  return <div className="chat-header">{model.assistantView === 'reflex' ? <JevAvatar state={reflex.avatar} size="large"/> : <SymbiAvatar state={visibleSymbiState} size="large"/>}<div><strong>{model.assistantView === 'reflex' ? 'Symbi Reflex' : 'Symbi'}</strong><span>{model.assistantView === 'reflex' ? (reflexCaption[reflex.avatar] ?? symbiCaption[reflex.avatar]) : symbiCaption[visibleSymbiState]}</span></div><ResearchCanvasButton model={model}/>{model.assistantView === 'chat' && <button ref={triggerRef} className="icon-button" title="New chat" aria-label="New chat" onClick={startNewChat}><Icon name="plus" size={18}/></button>}<button className="icon-button" title="Symbi settings" aria-label="Symbi settings" onClick={() => { if (model.assistantView === 'reflex') window.dispatchEvent(new Event('symbiknow:open-jev')); else model.setDialog('settings'); }}><Icon name="settings" size={18}/></button><button className="icon-button" title="Close Symbi panel" aria-label="Close Symbi panel" onClick={() => model.setShowChat(false)}><Icon name="close" size={18}/></button></div>;
}

function ResearchCanvasButton({ model }: { model: AppModel }) {
  return model.answerTurns.length > 0 ? <button className="chat-header__research-return" title="Open research canvas" aria-label="Open research canvas" onClick={() => model.setAnswerCanvasOpen(true)}><Icon name="grid" size={15}/><span>Research canvas</span></button> : null;
}
