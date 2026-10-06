import { useEffect, useRef } from 'react';
import type { AnswerSource, CanvasNavigationTarget } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import { locationFor, urlParam } from './app-model-helpers';
import type { AppState } from './app-state';
import { type CanvasPlace } from './useCanvasJourney';


export function useCanvasNavigationActions(state: AppState) {
  const groupFocusSequence = useRef(0);
  const {
    workspaces, canvasId, setCanvasId, canvas, setCanvas, navigationVersion, setDialog, setShowChat,
    setDocumentAssistantWidth, setAssistantView, setSearchOpen, setBrowseGroupsOpen,
    setAssistantFocusRequest, answerCanvasOpen, setAnswerCanvasOpen, setSelectedBlockIds, setVisibleBlockIds,
    setCanvasViewFocus, setViewportRequest, journey, setFocusRequest, setGroupFocusRequest,
    setReaderId, setSourceFocus, researchSourceReturn, activeCanvasId, workspacesRef,
    preferredWorkspaceId, chatReturn,
  } = state;

  function canvasName(id: string): string {
    return workspaces.flatMap(workspace => workspace.canvases).find(item => item.id === id)?.name ?? (canvas?.id === id ? canvas.name : id);
  }

  function updateCanvasLocation(id: string) {
    if (urlParam('canvas') !== id || urlParam('doc')) window.history.pushState({ canvasView: true }, '', locationFor(id));
  }

  function fallbackCanvasId() { return workspacesRef.current.flatMap(workspace => workspace.canvases)[0]?.id ?? ''; }

  function navigateTo(place: CanvasPlace, record = true) {
    navigationVersion.current++;
    setAnswerCanvasOpen(false);
    setSelectedBlockIds([]);
    setVisibleBlockIds([]);
    setCanvasViewFocus({ level: 'documents', visibleGroups: [] });
    setGroupFocusRequest(null);
    if (record) journey.visit(place);
    if (place.viewport) setViewportRequest(current => ({ ...place.viewport!, sequence: (current?.sequence ?? 0) + 1 }));
    else setViewportRequest(undefined);
    if (place.blockId) setFocusRequest(current => ({ canvasId: place.canvasId, blockId: place.blockId!, title: place.title ?? 'Document', sequence: (current?.sequence ?? 0) + 1 }));
    else setFocusRequest(null);
    activeCanvasId.current = place.canvasId;
    setCanvasId(place.canvasId);
    setCanvas(current => current?.id === place.canvasId ? current : null);
    setReaderId('');
    updateCanvasLocation(place.canvasId);
  }

  function selectCanvas(id: string) {
    setSearchOpen(false);
    setBrowseGroupsOpen(false);
    navigateTo({ canvasId: id, canvasName: canvasName(id) });
    preferredWorkspaceId.current = workspaces.find(workspace => workspace.canvases.some(item => item.id === id))?.id ?? preferredWorkspaceId.current;
  }

  useEffect(() => {
    if (canvas && journey.current?.canvasId !== canvas.id) journey.visit({ canvasId: canvas.id, canvasName: canvas.name });
  }, [canvas?.id]);

  useEffect(() => {
    function onPopState() {
      navigationVersion.current++;
      const requested = urlParam('canvas');
      const known = workspacesRef.current.some(workspace => workspace.canvases.some(item => item.id === requested));
      const next = known ? requested : fallbackCanvasId();
      if (!known) window.history.replaceState(null, '', locationFor(next));
      if (next !== activeCanvasId.current) {
        activeCanvasId.current = next;
        setCanvasId(next);
        setCanvas(null);
      }
      setReaderId(known ? urlParam('doc') : '');
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function showBlockOnCanvas(targetCanvasId: string, blockId: string, title: string, keepSearch = false) {
    setAnswerCanvasOpen(false);
    setDialog(null);
    if (!keepSearch) setSearchOpen(false);
    setReaderId('');
    if (window.matchMedia?.('(max-width: 620px)').matches) setShowChat(false);
    if (urlParam('doc')) window.history.replaceState(null, '', locationFor(targetCanvasId));
    navigateTo({ canvasId: targetCanvasId, canvasName: canvasName(targetCanvasId), blockId, title });
  }

  function navigateFromChat(target: CanvasNavigationTarget) {
    researchSourceReturn.current = false;
    chatReturn.current = { place: journey.current ?? { canvasId, canvasName: canvasName(canvasId) }, research: answerCanvasOpen };
    if (target.kind === 'document') {
      showBlockOnCanvas(target.canvasId, target.blockId, target.title);
      if (target.excerpt) { setSourceFocus(target); setReaderId(target.blockId); }
      return;
    }
    setSearchOpen(false);
    setReaderId('');
    navigateTo({ canvasId: target.canvasId, canvasName: canvasName(target.canvasId), title: target.title });
    setGroupFocusRequest({ canvasId: target.canvasId, group: target.group, sequence: ++groupFocusSequence.current });
  }

  function returnFromChatNavigation() {
    researchSourceReturn.current = false;
    const previous = chatReturn.current;
    if (!previous) { moveJourney(-1); return; }
    chatReturn.current = null;
    setSourceFocus(null);
    setReaderId('');
    navigateTo(journey.moveHistory(-1) ?? previous.place, false);
    if (previous.research) setAnswerCanvasOpen(true);
  }

  function openDocumentAssistant() {
    setShowChat(true);
    setAssistantView('chat');
    setAssistantFocusRequest(current => current + 1);
  }

  function updateDocumentAssistantWidth(width: number) {
    setDocumentAssistantWidth(width);
    try { window.localStorage.setItem('symbiknow.assistant.document-width', String(width)); }
    catch (reason) { console.warn('Document assistant width cannot be saved; it remains available for this session.', reason); }
  }

  function openReader(blockId: string) {
    navigationVersion.current++;
    researchSourceReturn.current = false;
    setSourceFocus(null);
    const block = canvas?.blocks.find(item => item.id === blockId);
    if (block && canvas) journey.visit({ canvasId: canvas.id, canvasName: canvas.name, blockId, title: block.title, viewport: journey.current?.viewport });
    setReaderId(blockId);
    window.history.pushState({ reader: true }, '', locationFor(activeCanvasId.current, blockId));
  }

  function openCrossLink(targetCanvasId: string, targetBlockId: string) {
    if (!targetCanvasId || !targetBlockId) return;
    navigationVersion.current++;
    setSearchOpen(false);
    setDialog(null);
    setAnswerCanvasOpen(false);
    setSelectedBlockIds([]);
    setVisibleBlockIds([]);
    setCanvasViewFocus({ level: 'documents', visibleGroups: [] });
    setGroupFocusRequest(null);
    setSourceFocus(null);
    // A previous saved viewport can otherwise win the destination camera on mount.
    setViewportRequest(undefined);
    setFocusRequest(current => ({ canvasId: targetCanvasId, blockId: targetBlockId,
      title: 'Document', sequence: (current?.sequence ?? 0) + 1 }));
    journey.visit({ canvasId: targetCanvasId, canvasName: canvasName(targetCanvasId), blockId: targetBlockId });
    activeCanvasId.current = targetCanvasId;
    setCanvasId(targetCanvasId);
    setCanvas(current => current?.id === targetCanvasId ? current : null);
    setReaderId(targetBlockId);
    window.history.pushState({ reader: true }, '', locationFor(targetCanvasId, targetBlockId));
  }

  function showReaderDocument(blockId: string) {
    navigationVersion.current++;
    setSourceFocus(null);
    setReaderId(blockId);
    window.history.replaceState(window.history.state, '', locationFor(activeCanvasId.current, blockId));
  }

  function closeReader() {
    navigationVersion.current++;
    if (researchSourceReturn.current) { returnFromChatNavigation(); return; }
    setSourceFocus(null);
    if (!urlParam('doc')) { setReaderId(''); return; }
    if ((window.history.state as { reader?: boolean } | null)?.reader) window.history.back();
    else { setReaderId(''); window.history.replaceState(null, '', locationFor(activeCanvasId.current)); }
  }

  function openResearchSource(source: AnswerSource) {
    navigateFromChat({ kind: 'document', canvasId: source.canvasId, blockId: source.blockId, title: source.title,
      excerpt: source.evidence?.passage ?? source.excerpt, contentHash: source.evidence?.contentHash ?? source.contentHash });
    researchSourceReturn.current = true;
  }

  function selectedOnCanvas(blocks: CanvasBlock[]) {
    setSelectedBlockIds(blocks.map(block => block.id));
    if (blocks.length !== 1 || !canvas) return;
    const block = blocks[0];
    journey.visit({ canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: block.title, viewport: journey.current?.viewport });
  }

  function moveJourney(direction: number) {
    const place = journey.moveHistory(direction);
    if (place) navigateTo(place, false);
  }

  return { canvasName, navigateTo, selectCanvas, showBlockOnCanvas, navigateFromChat, returnFromChatNavigation, openDocumentAssistant, updateDocumentAssistantWidth, openReader, openCrossLink, showReaderDocument, closeReader, openResearchSource, selectedOnCanvas };
}

export type CanvasNavigationActions = ReturnType<typeof useCanvasNavigationActions>;
