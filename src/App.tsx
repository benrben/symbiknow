import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Canvas, type BlockPosition } from './Canvas';
import { AnswerCanvas } from './AnswerCanvas';
import type { AnswerCanvasResult, AnswerCanvasTurn, AnswerCanvasViewFocus, AnswerSource, CanvasNavigationTarget, CanvasViewFocus, ChatViewContext, ResearchCanvasPatch, ResearchLayout } from '../shared/answer-canvas';
import { editedResearchGraph, emptyResearchEdits, savedResearchContent, type ResearchCanvasEdits } from './research-edits';
import { sameDocument, type CanvasChanges, type CanvasEdit } from './canvas-changes';
import type { MergeDraftRequest } from './AIElementsChat';
import { ResizableAssistant } from './ResizableAssistant';
import type { SettingsPayload } from './SettingsPage';
import { api, authRequiredEvent, browserActor } from './api';
import { registerWebMCP } from './webmcp';
import { applyTheme, preferredTheme, type Theme } from './theme';
import { BrandMark, Icon, ThemeToggle } from './AppIcon';
import { FullPageReader, MergeReviewDialog, ModalOverlay } from './AppDialogs';
import { blockPath, importedFile, initialDraft, locationFor, starterContent, urlParam, type BlockDraft, type Dialog } from './app-model-helpers';
import { CanvasSearch } from './CanvasSearch';
import { GroupSuggestions } from './GroupSuggestions';
import { CanvasNavigation } from './CanvasNavigation';
import { useCanvasJourney, type CanvasPlace, type CanvasViewport } from './useCanvasJourney';
import type { InsightAction, InsightItem, ReadingPath } from '../shared/insights';
import type { CanvasBlock, CanvasDocument, ChatSettings, SearchHit, WorkspaceSummary } from '../shared/types';

type AssistantView = 'chat' | 'insights' | 'tasks';
type ResearchActionRequest = { kind: 'add' | 'search' | 'groups' | 'upload'; sequence: number; files?: File[] };
type MergeSource = { canvasId: string; item: InsightItem; action: Extract<InsightAction, { type: 'merge' }>; blocks: CanvasBlock[] };
type MergeReview = MergeSource & { content: string };

const ChatView = lazy(() => import('./AIElementsChat').then(module => ({ default: memo(module.AIElementsChat) })));
const InsightsView = lazy(() => import('./InsightsPanel').then(module => ({ default: memo(module.InsightsPanel) })));
const TasksView = lazy(() => import('./TasksPanel').then(module => ({ default: memo(module.TasksPanel) })));
const MemoCanvas = memo(Canvas);

/** Keep the large Markdown body out of the periodic equality check. */
function sameCanvas(left: CanvasDocument | null, right: CanvasDocument): boolean {
  if (!left || left.id !== right.id || left.name !== right.name || left.workspaceId !== right.workspaceId || left.blocks.length !== right.blocks.length) return false;
  return left.blocks.every((block, index) => {
    const next = right.blocks[index];
    return block.id === next.id && block.title === next.title && block.file === next.file && block.kind === next.kind
      && block.x === next.x && block.y === next.y && block.width === next.width && block.height === next.height
      && block.contentHash === next.contentHash && (block.contentHash || block.content === next.content)
      && block.purpose === next.purpose && block.reviewer === next.reviewer && block.group === next.group
      && block.workArea === next.workArea && block.archived === next.archived && block.stale === next.stale
      && JSON.stringify(block.links) === JSON.stringify(next.links)
      && JSON.stringify(block.linkTypes) === JSON.stringify(next.linkTypes)
      && JSON.stringify(block.crossLinks) === JSON.stringify(next.crossLinks)
      && JSON.stringify(block.tags) === JSON.stringify(next.tags)
      && JSON.stringify(block.quality) === JSON.stringify(next.quality)
      && JSON.stringify(block.lock) === JSON.stringify(next.lock);
  });
}

function useStableEvent<T extends (...args: never[]) => unknown>(callback: T): T {
  const current = useRef(callback);
  useLayoutEffect(() => { current.current = callback; }, [callback]);
  return useCallback(((...args: Parameters<T>) => current.current(...args)) as T, []);
}

function replaceBlock(document: CanvasDocument | null, canvasId: string, blockId: string, updated: CanvasBlock) {
  if (!document || document.id !== canvasId) return document;
  return { ...document, blocks: document.blocks.map(block => block.id === blockId ? updated : block) };
}

const defaultSettings: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: false, hasJevApiKey: false, reviewers: '', workAreas: '' };

function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

async function readCanvas(id: string, etag?: string): Promise<{ document?: CanvasDocument; etag?: string }> {
  let response: Response;
  try {
    response = await fetch('/api/canvases/' + encodeURIComponent(id), {
      cache: 'no-store',
      headers: { 'x-symbiknow-actor': browserActor, ...(etag ? { 'If-None-Match': etag } : {}) },
    });
  } catch {
    throw new Error('Canvas server is unavailable. Check that it is running, then retry.');
  }
  if (response.status === 304) return { etag };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(authRequiredEvent));
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (payload?.error) throw new Error(payload.error);
    if ([502, 503, 504].includes(response.status)) throw new Error(`Canvas server is unavailable or restarting (${response.status}). Retry in a moment.`);
    throw new Error(`Request failed (${response.status})`);
  }
  return { document: await response.json() as CanvasDocument, etag: response.headers.get('ETag') ?? undefined };
}

async function saveInsightLink(canvasId: string, action: Extract<InsightAction, { type: 'link' | 'unlink' }>) {
  const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasId));
  const source = document.blocks.find(block => block.id === action.fromBlockId);
  if (!source) throw new Error('A linked document no longer exists. Analyze the canvas again.');
  const target = document.blocks.find(block => block.id === action.toBlockId);
  if (action.type === 'link' && !target) {
    throw new Error('A linked document no longer exists. Analyze the canvas again.');
  }
  const links = action.type === 'unlink' ? source.links.filter(link => link !== action.toBlockId)
    : [...new Set([...source.links, action.toBlockId])];
  const linkTypes = { ...source.linkTypes };
  if (action.type === 'unlink') delete linkTypes[action.toBlockId];
  else if (action.relation) linkTypes[action.toBlockId] = action.relation;
  await api(blockPath(canvasId, source.id), { method: 'PUT', body: JSON.stringify({ links, linkTypes }) });
  if (action.type === 'link' && action.relation === 'supersedes' && target) {
    await api(blockPath(canvasId, target.id), { method: 'PUT', body: JSON.stringify({ stale: true }) });
  }
}

async function saveInsightAction(canvasId: string, action: InsightAction) {
  if (action.type === 'layout') {
    await api('/canvases/' + encodeURIComponent(canvasId) + '/layout', { method: 'PUT', body: JSON.stringify({ positions: action.positions }) });
  } else if (action.type === 'update') {
    await api(blockPath(canvasId, action.blockId), { method: 'PUT', body: JSON.stringify(action.patch) });
  } else if (action.type === 'link' || action.type === 'unlink') {
    await saveInsightLink(canvasId, action);
  } else if (action.type === 'move') {
    await api(`/canvases/${encodeURIComponent(canvasId)}/blocks/${encodeURIComponent(action.blockId)}/move`, {
      method: 'POST', body: JSON.stringify({ targetCanvasId: action.toCanvasId }),
    });
  } else {
    throw new Error(`This insight action needs a dedicated review flow: ${action.type}`);
  }
}

function useAppModel() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [canvasId, setCanvasId] = useState('');
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [crossLinkLabels, setCrossLinkLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draftName, setDraftName] = useState('');
  const [canvasToDelete, setCanvasToDelete] = useState<{ id: string; name: string; workspaceId: string } | null>(null);
  const [draftBlock, setDraftBlock] = useState<BlockDraft>(initialDraft);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(defaultSettings);
  const [showChat, setShowChat] = useState(() => !window.matchMedia?.('(max-width: 620px)').matches);
  const [chatSession, setChatSession] = useState(0);
  const [assistantView, setAssistantView] = useState<AssistantView>('chat');
  const [authRequired, setAuthRequired] = useState(false);
  const [draftLock, setDraftLock] = useState<CanvasBlock['lock']>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchResultQuery, setSearchResultQuery] = useState('');
  const [activeSearchId, setActiveSearchId] = useState('');
  const [groupSuggestionsOpen, setGroupSuggestionsOpen] = useState(false);
  const [previewGroups, setPreviewGroups] = useState<Record<string, string> | null>(null);
  const [chatPromptRequest, setChatPromptRequest] = useState<{ text: string; sequence: number; mergeDraft?: MergeDraftRequest }>();
  const [answerTurns, setAnswerTurns] = useState<AnswerCanvasTurn[]>([]);
  const [researchState, setResearchState] = useState<{ edits: ResearchCanvasEdits; history: ResearchCanvasEdits[] }>(() => ({ edits: emptyResearchEdits(), history: [] }));
  const [researchSaveCount, setResearchSaveCount] = useState(0);
  const [answerCanvasOpen, setAnswerCanvasOpen] = useState(false);
  const [researchActionRequest, setResearchActionRequest] = useState<ResearchActionRequest>();
  const [researchLayout, setResearchLayout] = useState<ResearchLayout>('mindmap');
  const [answerCanvasViewFocus, setAnswerCanvasViewFocus] = useState<AnswerCanvasViewFocus>({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [visibleBlockIds, setVisibleBlockIds] = useState<string[]>([]);
  const [canvasViewFocus, setCanvasViewFocus] = useState<CanvasViewFocus>({ level: 'documents', visibleGroups: [] });
  const [duplicateRequest, setDuplicateRequest] = useState<{ canvasId: string; blockId: string; sequence: number }>();
  const [mergeSource, setMergeSource] = useState<MergeSource | null>(null);
  const [mergeReview, setMergeReview] = useState<MergeReview | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeUndo, setMergeUndo] = useState<{ mergeId: string; canvasId: string; title: string } | null>(null);
  const [readingPath, setReadingPath] = useState<ReadingPath | null>(null);
  const [viewportRequest, setViewportRequest] = useState<(CanvasViewport & { sequence: number })>();
  const journey = useCanvasJourney();
  const [focusRequest, setFocusRequest] = useState<{ canvasId: string; blockId: string; title: string; sequence: number } | null>(null);
  const [groupFocusRequest, setGroupFocusRequest] = useState<{ canvasId: string; group: string; sequence: number } | null>(null);
  const [readerId, setReaderId] = useState('');
  const [versionBlockId, setVersionBlockId] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const canvasCache = useRef(new Map<string, CanvasDocument>());
  const canvasEtags = useRef(new Map<string, string>());
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

  function rememberCanvas(document: CanvasDocument) {
    const cache = canvasCache.current;
    cache.delete(document.id);
    cache.set(document.id, document);
    if (cache.size <= 8) return;
    for (const id of cache.keys()) {
      if (id === activeCanvasId.current) continue;
      cache.delete(id);
      canvasEtags.current.delete(id);
      break;
    }
  }

  function canvasName(id: string): string {
    return workspaces.flatMap(workspace => workspace.canvases).find(item => item.id === id)?.name ?? (canvas?.id === id ? canvas.name : id);
  }

  function navigateTo(place: CanvasPlace, record = true) {
    setAnswerCanvasOpen(false);
    setSelectedBlockIds([]);
    setVisibleBlockIds([]);
    setCanvasViewFocus({ level: 'documents', visibleGroups: [] });
    setGroupFocusRequest(null);
    if (record) journey.visit(place);
    if (place.viewport) setViewportRequest(current => ({ ...place.viewport!, sequence: (current?.sequence ?? 0) + 1 }));
    if (place.blockId) setFocusRequest(current => ({ canvasId: place.canvasId, blockId: place.blockId!, title: place.title ?? 'Document', sequence: (current?.sequence ?? 0) + 1 }));
    else setFocusRequest(null);
    activeCanvasId.current = place.canvasId;
    setCanvasId(place.canvasId);
    setCanvas(canvasCache.current.get(place.canvasId) ?? null);
    setReaderId('');
    setReadingPath(null);
    if (urlParam('canvas') !== place.canvasId || urlParam('doc')) window.history.pushState({ canvasView: true }, '', locationFor(place.canvasId));
  }

  function selectCanvas(id: string) {
    setSearchOpen(false);
    setGroupSuggestionsOpen(false);
    navigateTo({ canvasId: id, canvasName: canvasName(id) });
    preferredWorkspaceId.current = workspaces.find(workspace => workspace.canvases.some(item => item.id === id))?.id ?? preferredWorkspaceId.current;
  }

  async function refreshWorkspaces(preferredCanvasId: string) {
    const list = await api<WorkspaceSummary[]>('/workspaces');
    setWorkspaces(list);
    preferredWorkspaceId.current = list.find(workspace => workspace.canvases.some(item => item.id === preferredCanvasId))?.id ?? preferredWorkspaceId.current;
    activeCanvasId.current = preferredCanvasId;
    setCanvasId(preferredCanvasId);
    setCanvas(canvasCache.current.get(preferredCanvasId) ?? null);
  }

  async function refreshAfterVersionChange() { await loadCanvas(activeCanvasId.current); }

  async function loadCanvas(id = activeCanvasId.current) {
    if (!id) { setCanvas(null); return null; }
    const version = (canvasLoadVersions.current.get(id) ?? 0) + 1;
    canvasLoadVersions.current.set(id, version);
    const result = await readCanvas(id, canvasEtags.current.get(id));
    if (version !== canvasLoadVersions.current.get(id)) return canvasCache.current.get(id) ?? result.document ?? null;
    if (result.etag) canvasEtags.current.set(id, result.etag);
    else canvasEtags.current.delete(id);
    const document = result.document ?? canvasCache.current.get(id);
    if (!document) return null;
    if (result.document) rememberCanvas(document);
    if (result.document && activeCanvasId.current === id) {
      setCanvas(current => sameCanvas(current, document) ? current : document);
    }
    return document;
  }

  useEffect(() => { if (canvas) rememberCanvas(canvas); }, [canvas]);

  const [session, setSession] = useState(0);

  useEffect(() => {
    function onAuthRequired() { setAuthRequired(true); }
    window.addEventListener(authRequiredEvent, onAuthRequired);
    return () => window.removeEventListener(authRequiredEvent, onAuthRequired);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([api<WorkspaceSummary[]>('/workspaces'), api<ChatSettings>('/settings')])
      .then(([list, currentSettings]) => {
        if (!active) return;
        setWorkspaces(list);
        workspacesRef.current = list;
        setSettings(currentSettings);
        const requested = urlParam('canvas');
        const known = list.some(workspace => workspace.canvases.some(item => item.id === requested));
        const initialId = known ? requested : list[0]?.canvases[0]?.id || '';
        preferredWorkspaceId.current = list.find(workspace => workspace.canvases.some(item => item.id === initialId))?.id ?? list[0]?.id ?? '';
        activeCanvasId.current = initialId;
        setCanvasId(initialId);
      })
      .catch(failure => { if (active) setError(errorText(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!canvasId) { setCanvas(null); return; }
    let active = true;
    setCanvas(canvasCache.current.get(canvasId) ?? null);
    if (urlParam('canvas') !== canvasId) {
      window.history.replaceState(null, '', locationFor(canvasId));
      setReaderId('');
    }
    loadCanvas(canvasId)
      .then(document => {
        if (!active || !document) return;
        const doc = urlParam('doc');
        setReaderId(doc && document.blocks.some(block => block.id === doc) ? doc : '');
      })
      .catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [canvasId]);

  const crossLinkKey = canvas?.blocks.flatMap(block => block.crossLinks ?? [])
    .map(link => `${link.canvasId}:${link.blockId}`).sort().join('\u0000') ?? '';
  useEffect(() => {
    const links = canvas?.blocks.flatMap(block => block.crossLinks ?? []) ?? [];
    if (!links.length) { setCrossLinkLabels({}); return; }
    let active = true;
    const targetCanvasIds = [...new Set(links.map(link => link.canvasId))];
    void Promise.all(targetCanvasIds.map(async id => {
      const cached = canvasCache.current.get(id);
      if (cached) return cached;
      const target = await api<CanvasDocument>('/canvases/' + encodeURIComponent(id)).catch(() => null);
      if (target) rememberCanvas(target);
      return target;
    }))
      .then(documents => {
        if (!active) return;
        const targets = new Map(documents.filter((document): document is CanvasDocument => document !== null).map(document => [document.id, document]));
        const labels: Record<string, string> = {};
        for (const link of links) {
          const target = targets.get(link.canvasId);
          const block = target?.blocks.find(item => item.id === link.blockId);
          if (target && block) labels[`${link.canvasId}:${link.blockId}`] = `${target.name} · ${block.title}`;
        }
        setCrossLinkLabels(labels);
      });
    return () => { active = false; };
  }, [canvas?.id, crossLinkKey]);

  useEffect(() => {
    if (canvas && journey.current?.canvasId !== canvas.id) journey.visit({ canvasId: canvas.id, canvasName: canvas.name });
  }, [canvas?.id]);

  // Agents edit the same canvas over MCP. Refresh when the user is idle and the tab is visible.
  useEffect(() => {
    if (!canvasId) return;
    const markInteraction = () => { lastInteraction.current = Date.now(); };
    const refresh = () => {
      if (document.visibilityState === 'visible' && !dialogRef.current && Date.now() - lastInteraction.current > 1500) {
        void loadCanvas(canvasId).catch(() => undefined);
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('pointerdown', markInteraction, { passive: true });
    window.addEventListener('keydown', markInteraction);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', markInteraction);
      window.removeEventListener('keydown', markInteraction);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [canvasId]);

  useEffect(() => {
    function onPopState() {
      const requested = urlParam('canvas');
      const known = workspacesRef.current.some(workspace => workspace.canvases.some(item => item.id === requested));
      const next = known ? requested : workspacesRef.current.flatMap(workspace => workspace.canvases)[0]?.id ?? '';
      if (!known) window.history.replaceState(null, '', locationFor(next));
      if (next !== activeCanvasId.current) {
        activeCanvasId.current = next;
        setCanvasId(next);
        setCanvas(canvasCache.current.get(next) ?? null);
      }
      setReaderId(known ? urlParam('doc') : '');
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) { setSearchHits([]); setSearching(false); setSearchResultQuery(''); return; }
    setSearching(true);
    setSearchHits([]);
    let active = true;
    const timer = window.setTimeout(() => {
      api<SearchHit[]>('/search?q=' + encodeURIComponent(query))
        .then(hits => { if (active) { setSearchHits(hits); setSearchResultQuery(query); setSearching(false); } })
        .catch(failure => { if (active) { setSearchResultQuery(query); setSearching(false); setError(errorText(failure)); } });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [searchQuery]);

  useEffect(() => {
    return registerWebMCP(() => activeCanvasId.current, () => {
      void loadCanvas().catch(failure => setError(errorText(failure)));
    });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if (event.key === 'Escape') { setSearchOpen(false); closeReader(); if (!busy) setDialog(null); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); setDialog(null); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  function openNewBlock() {
    setDraftBlock({ title: 'Untitled note', kind: 'markdown', content: starterContent.markdown });
    setDialog('block');
  }

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
    chatReturn.current = { place: journey.current ?? { canvasId, canvasName: canvasName(canvasId) }, research: answerCanvasOpen };
    if (target.kind === 'document') {
      showBlockOnCanvas(target.canvasId, target.blockId, target.title);
      return;
    }
    setSearchOpen(false);
    setReaderId('');
    navigateTo({ canvasId: target.canvasId, canvasName: canvasName(target.canvasId), title: target.title });
    setGroupFocusRequest(current => ({ canvasId: target.canvasId, group: target.group, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function returnFromChatNavigation() {
    const previous = chatReturn.current;
    if (!previous) { moveJourney(-1); return; }
    chatReturn.current = null;
    navigateTo(journey.moveHistory(-1) ?? previous.place, false);
    if (previous.research) setAnswerCanvasOpen(true);
  }

  function openBlock(block: CanvasBlock) {
    setDraftBlock({ id: block.id, title: block.title, kind: block.kind, content: block.content, contentHash: block.contentHash });
    setDraftLock(block.lock?.owner === browserActor ? undefined : block.lock);
    setDialog('block');
  }

  function openReader(blockId: string) {
    setReadingPath(null);
    const block = canvas?.blocks.find(item => item.id === blockId);
    if (block && canvas) journey.visit({ canvasId: canvas.id, canvasName: canvas.name, blockId, title: block.title, viewport: journey.current?.viewport });
    setReaderId(blockId);
    window.history.pushState({ reader: true }, '', locationFor(activeCanvasId.current, blockId));
  }

  function openCrossLink(targetCanvasId: string, targetBlockId: string) {
    if (!targetCanvasId || !targetBlockId) return;
    setSearchOpen(false);
    setDialog(null);
    journey.visit({ canvasId: targetCanvasId, canvasName: canvasName(targetCanvasId), blockId: targetBlockId });
    activeCanvasId.current = targetCanvasId;
    setCanvasId(targetCanvasId);
    setCanvas(canvasCache.current.get(targetCanvasId) ?? null);
    setReaderId(targetBlockId);
    setReadingPath(null);
    window.history.pushState({ reader: true }, '', locationFor(targetCanvasId, targetBlockId));
  }

  /** Move to another document without adding history entries, so Back still returns to the canvas. */
  function showReaderDocument(blockId: string) {
    setReaderId(blockId);
    window.history.replaceState(window.history.state, '', locationFor(activeCanvasId.current, blockId));
  }

  function closeReader() {
    setReadingPath(null);
    if (!urlParam('doc')) { setReaderId(''); return; }
    if ((window.history.state as { reader?: boolean } | null)?.reader) window.history.back();
    else { setReaderId(''); window.history.replaceState(null, '', locationFor(activeCanvasId.current)); }
  }

  async function takeOverLock(blockId: string) {
    try {
      await api(blockPath(canvasId, blockId) + '/lock?force=1', { method: 'DELETE' });
      setDraftLock(undefined);
      await loadCanvas(canvasId);
    } catch (failure) { setError(errorText(failure)); }
  }

  const moveBlocks = useCallback(async (positions: BlockPosition[]) => {
    const id = activeCanvasId.current;
    await api('/canvases/' + encodeURIComponent(id) + '/layout', { method: 'PUT', body: JSON.stringify({ positions }) });
    if (activeCanvasId.current === id) await loadCanvas(id);
  }, []);

  function openVersionHistory(block: CanvasBlock) {
    setVersionBlockId(block.id);
    setDialog('versions');
  }

  async function saveBlock(event: FormEvent) {
    event.preventDefault();
    if (!canvasId || !draftBlock.title.trim()) return;
    await perform(async () => {
      const payload = { title: draftBlock.title.trim(), kind: draftBlock.kind, content: draftBlock.content,
        ...(draftBlock.id && draftBlock.contentHash ? { expectedContentHash: draftBlock.contentHash } : {}) };
      if (draftBlock.id) await api<CanvasBlock>(blockPath(canvasId, draftBlock.id), { method: 'PUT', body: JSON.stringify(payload) });
      else {
        const created = await api<CanvasBlock>('/canvases/' + encodeURIComponent(canvasId) + '/blocks', { method: 'POST', body: JSON.stringify(payload) });
        if (activeCanvasId.current === canvasId) showBlockOnCanvas(canvasId, created.id, created.title);
      }
      await loadCanvas(canvasId);
    });
  }

  const updateBlock = useCallback(async (blockId: string, patch: Partial<CanvasBlock>) => {
    try {
      const updated = await api<CanvasBlock>(blockPath(canvasId, blockId), { method: 'PUT', body: JSON.stringify(patch) });
      setCanvas(current => replaceBlock(current, canvasId, blockId, updated));
    } catch (failure) { setError(errorText(failure)); throw failure; }
  }, [canvasId]);

  const deleteCanvasBlock = useCallback(async (blockId: string) => {
    try {
      await api(blockPath(canvasId, blockId), { method: 'DELETE' });
      await loadCanvas(canvasId);
    } catch (failure) { setError(errorText(failure)); throw failure; }
  }, [canvasId]);

  async function deleteBlock() {
    await perform(async () => {
      await api(blockPath(canvasId, draftBlock.id!), { method: 'DELETE' });
      await loadCanvas(canvasId);
    });
  }

  async function createWorkspace(name: string) {
    const created = await api<WorkspaceSummary>('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    const firstCanvas = await api<CanvasDocument>('/workspaces/' + encodeURIComponent(created.id) + '/canvases', { method: 'POST', body: JSON.stringify({ name: 'Untitled canvas' }) });
    await refreshWorkspaces(firstCanvas.id);
  }

  async function createCanvas(name: string) {
    const workspaceId = canvas?.workspaceId || preferredWorkspaceId.current || workspaces[0]?.id;
    if (!workspaceId) throw new Error('Create a workspace first.');
    const created = await api<CanvasDocument>('/workspaces/' + encodeURIComponent(workspaceId) + '/canvases', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshWorkspaces(created.id);
  }

  function requestDeleteCanvas(id: string, name: string, workspaceId: string) {
    setError('');
    setCanvasToDelete({ id, name, workspaceId });
    setDialog('delete-canvas');
  }

  async function deleteCanvas() {
    if (!canvasToDelete) return;
    const target = canvasToDelete;
    await perform(async () => {
      await api('/canvases/' + encodeURIComponent(target.id), { method: 'DELETE' });
      canvasCache.current.delete(target.id);
      canvasEtags.current.delete(target.id);
      canvasLoadVersions.current.set(target.id, (canvasLoadVersions.current.get(target.id) ?? 0) + 1);
      journey.forgetCanvas(target.id);
      if (chatReturn.current?.place.canvasId === target.id) chatReturn.current = null;
      setMergeUndo(current => current?.canvasId === target.id ? null : current);
      setMergeReview(null);
      const list = workspacesRef.current.map(workspace => ({ ...workspace,
        canvases: workspace.canvases.filter(item => item.id !== target.id) }));
      workspacesRef.current = list;
      setWorkspaces(list);
      setSearchHits(current => current.filter(hit => hit.canvasId !== target.id));
      if (activeCanvasId.current === target.id) {
        preferredWorkspaceId.current = target.workspaceId;
        const next = list.find(workspace => workspace.id === target.workspaceId)?.canvases[0]
          ?? list.flatMap(workspace => workspace.canvases)[0];
        const nextId = next?.id ?? '';
        window.history.replaceState(null, '', locationFor(nextId));
        activeCanvasId.current = nextId;
        setCanvasId(nextId);
        setCanvas(nextId ? canvasCache.current.get(nextId) ?? null : null);
        setReaderId('');
        setReadingPath(null);
        setAnswerCanvasOpen(false);
        setFocusRequest(null);
        setGroupFocusRequest(null);
        setSelectedBlockIds([]);
      }
      setCanvasToDelete(null);
    });
  }

  async function createNamed(event: FormEvent) {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    await perform(async () => {
      if (dialog === 'workspace') await createWorkspace(name);
      if (dialog === 'canvas') await createCanvas(name);
      setDraftName('');
    });
  }

  async function uploadFile(file: File, targetCanvasId: string) {
    const imported = await importedFile(file);
    return api<CanvasBlock>('/canvases/' + encodeURIComponent(targetCanvasId) + '/blocks', {
      method: 'POST',
      body: JSON.stringify({ title: file.name.replace(/\.(md|mdx|html)$/i, ''), ...imported }),
    });
  }

  async function importEditedFile(file: File) {
    try {
      const imported = await importedFile(file);
      setDraftBlock(current => ({ ...current, content: imported.content, kind: /\.md$/i.test(file.name) ? current.kind : imported.kind }));
    } catch (failure) { setError(errorText(failure)); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || !canvasId) return;
    await perform(async () => {
      let last: CanvasBlock | undefined;
      for (const file of Array.from(files)) last = await uploadFile(file, canvasId);
      await loadCanvas(canvasId);
      if (last) showBlockOnCanvas(canvasId, last.id, last.title);
    });
    if (uploadRef.current) uploadRef.current.value = '';
  }

  async function saveSettings(payload: SettingsPayload) {
    await perform(async () => {
      setSettings(await api<ChatSettings>('/settings', { method: 'PUT', body: JSON.stringify(payload) }));
    });
  }

  async function signIn(token: string): Promise<string> {
    try {
      await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
      setAuthRequired(false);
      setError('');
      setSession(value => value + 1);
      return '';
    } catch (failure) { return errorText(failure); }
  }

  async function refreshCanvasAfterChat(id: string, beforeBlocks: CanvasBlock[]): Promise<CanvasChanges> {
    try {
      const updated = await loadCanvas(id);
      const before = new Map(beforeBlocks.map(block => [block.id, block]));
      return { created: updated?.blocks.filter(block => !before.has(block.id)) ?? [],
        updated: updated?.blocks.flatMap(block => {
          const original = before.get(block.id);
          return original && !sameDocument(original, block) ? [{ before: original, after: block }] : [];
        }) ?? [] };
    } catch (failure) { setError(errorText(failure)); return { created: [], updated: [] }; }
  }

  async function undoAgentCreatedBlock(targetCanvasId: string, created: CanvasBlock): Promise<void> {
    const latest = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId));
    const current = latest.blocks.find(block => block.id === created.id);
    if (!current) throw new Error('This document is already gone.');
    const changed = current.title !== created.title || current.kind !== created.kind || current.content !== created.content
      || JSON.stringify(current.links) !== JSON.stringify(created.links)
      || (created.contentHash && current.contentHash !== created.contentHash)
      || latest.blocks.some(block => block.id !== created.id && block.links.includes(created.id));
    if (changed) throw new Error('This document changed after the agent created it. Review it before deleting.');
    await api(`/canvases/${encodeURIComponent(targetCanvasId)}/blocks/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
    await loadCanvas(targetCanvasId);
  }

  async function undoAgentEditedBlock(targetCanvasId: string, edit: CanvasEdit): Promise<void> {
    const latest = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId));
    const current = latest.blocks.find(block => block.id === edit.after.id);
    if (!current || !sameDocument(current, edit.after) || current.contentHash !== edit.after.contentHash)
      throw new Error('This document changed again. Review its history before restoring it.');
    if (JSON.stringify(edit.before.quality) !== JSON.stringify(edit.after.quality))
      throw new Error('This quality change needs review in document history.');
    const before = edit.before;
    await api(`/canvases/${encodeURIComponent(targetCanvasId)}/blocks/${encodeURIComponent(before.id)}`, { method: 'PUT', body: JSON.stringify({
      expectedContentHash: current.contentHash, title: before.title, kind: before.kind, content: before.content,
      x: before.x, y: before.y, width: before.width, height: before.height,
      links: before.links, linkTypes: before.linkTypes ?? {}, crossLinks: before.crossLinks ?? [],
      archived: before.archived ?? false, stale: before.stale ?? false, tags: before.tags ?? [],
      purpose: before.purpose ?? '', reviewer: before.reviewer ?? '', workArea: before.workArea ?? '', group: before.group ?? null,
      message: `Undo agent edit to ${before.title}`,
    }) });
    await loadCanvas(targetCanvasId);
  }

  function retryConnection() {
    setError('');
    setLoading(true);
    setSession(current => current + 1);
  }

  useEffect(() => {
    if (!error.includes('server is unavailable')) return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void fetch('/api/workspaces', { cache: 'no-store' }).then(response => {
        if (response.ok) retryConnection();
      }).catch(() => undefined).finally(() => { checking = false; });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [error]);

  async function applyInsight(action: InsightAction) {
    const id = activeCanvasId.current;
    try {
      await saveInsightAction(id, action);
      await loadCanvas(id);
    } catch (failure) { setError(errorText(failure)); throw failure; }
  }

  async function startMergeDraft(item: InsightItem, action: Extract<InsightAction, { type: 'merge' }>) {
    const id = activeCanvasId.current;
    try {
      setError('');
      const latest = await api<CanvasDocument>('/canvases/' + encodeURIComponent(id));
      if (activeCanvasId.current !== id) return;
      const ids = [action.keepBlockId, ...action.mergeBlockIds];
      const blocks = ids.map(blockId => latest.blocks.find(block => block.id === blockId));
      if (blocks.some(block => !block || block.archived || !block.contentHash)) throw new Error('A merge document changed. Analyze the canvas again.');
      const authorization = await api<{ token: string }>('/chat/intents', { method: 'POST', body: JSON.stringify({
        canvasId: id, action: 'merge documents', blockIds: ids,
      }) });
      if (activeCanvasId.current !== id) return;
      const source: MergeSource = { canvasId: id, item, action, blocks: blocks as CanvasBlock[] };
      setMergeSource(source);
      setMergeReview(null);
      setShowChat(true);
      setAssistantView('chat');
      const names = source.blocks.map(block => `${block.title} (${block.id})`).join(', ');
      const text = `Draft a merge of these documents: ${names}. Keep ${source.blocks[0].title} (${action.keepBlockId}) as the surviving document. Read the full content of every source document. Follow this merge plan: ${JSON.stringify(action.plan)}. Preserve all unique, still-valid information. Resolve conflicting claims explicitly, without inventing facts. Return the complete proposed Markdown for the surviving document in one fenced markdown code block. This is a preview only; do not edit, archive, or move any document.`;
      setChatPromptRequest(current => ({ text, mergeDraft: { keepBlockId: action.keepBlockId, mergeBlockIds: action.mergeBlockIds, intentToken: authorization.token }, sequence: (current?.sequence ?? 0) + 1 }));
    } catch (failure) { setError(errorText(failure)); }
  }

  function receiveMergeDraft(content: string, request: MergeDraftRequest) {
    if (!mergeSource || mergeSource.canvasId !== activeCanvasId.current) return;
    if (request.keepBlockId !== mergeSource.action.keepBlockId
      || JSON.stringify(request.mergeBlockIds) !== JSON.stringify(mergeSource.action.mergeBlockIds)) return;
    setError('');
    setMergeReview({ ...mergeSource, content });
  }

  async function applyMergeReview() {
    if (!mergeReview || mergeBusy) return;
    const review = mergeReview;
    setMergeBusy(true);
    setError('');
    try {
      const expectedContentHashes = Object.fromEntries(review.blocks.map(block => [block.id, block.contentHash]));
      const result = await api<{ mergeId: string }>(`/canvases/${encodeURIComponent(review.canvasId)}/merge`, { method: 'POST', body: JSON.stringify({
        keepBlockId: review.action.keepBlockId, mergeBlockIds: review.action.mergeBlockIds,
        content: review.content, expectedContentHashes,
      }) });
      if (result.mergeId) setMergeUndo({ mergeId: result.mergeId, canvasId: review.canvasId, title: review.blocks[0].title });
      setMergeReview(null);
      setMergeSource(null);
      await loadCanvas(review.canvasId);
      try {
        await api(`/canvases/${encodeURIComponent(review.canvasId)}/insights/feedback`, { method: 'POST', body: JSON.stringify({
          itemId: review.item.id, category: review.item.category, confidence: review.item.confidence, decision: 'applied',
        }) });
      } catch (failure) { setError(`Merge saved, but feedback could not be recorded. ${errorText(failure)}`); }
    } catch (failure) { setError(errorText(failure)); }
    finally { setMergeBusy(false); }
  }

  async function undoMerge() {
    if (!mergeUndo || mergeBusy) return;
    const undo = mergeUndo;
    setMergeBusy(true); setError('');
    try {
      await api(`/merges/${encodeURIComponent(undo.mergeId)}/undo`, { method: 'POST' });
      setMergeUndo(null);
      await loadCanvas(undo.canvasId);
    } catch (failure) { setError(errorText(failure)); }
    finally { setMergeBusy(false); }
  }

  function draftGap(item: InsightItem) {
    const source = item.blockIds.map(id => canvas?.blocks.find(block => block.id === id)).filter((block): block is CanvasBlock => Boolean(block));
    setShowChat(true);
    setAssistantView('chat');
    const text = `Draft a new Markdown document to cover this missing documentation: ${item.title}. ${item.detail} Read the relevant source document${source.length === 1 ? '' : 's'} (${source.map(block => `${block.title} (${block.id})`).join(', ')}). Identify the actual missing dependency. Propose a title and outline, then show the complete Markdown draft in chat for review. Do not save anything on this turn. If I explicitly approve the draft in a later chat message, create the new document and use link_blocks from the new document to the source document with relation prerequisite. Confirm both saved changes after that approval.`;
    setChatPromptRequest(current => ({ text, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function startReadingPath(path: ReadingPath) {
    const ids = path.blockIds.filter(id => canvas?.blocks.some(block => block.id === id));
    if (!ids.length) return;
    openReader(ids[0]);
    setReadingPath({ ...path, blockIds: ids });
  }

  function findDuplicatesOfBlock(blockId: string) {
    if (!canvas?.blocks.some(block => block.id === blockId)) return;
    setShowChat(true);
    setAssistantView('insights');
    setDuplicateRequest(current => ({ canvasId: canvas.id, blockId, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function openInsightBlock(blockId: string) {
    if (canvas?.blocks.some(item => item.id === blockId)) openReader(blockId);
  }

  async function selectSearchHit(hit: SearchHit) {
    setSearchOpen(false);
    navigateTo({ canvasId: hit.canvasId, canvasName: hit.canvasName, blockId: hit.blockId, title: hit.title });
    try {
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(hit.canvasId));
      const block = document.blocks.find(item => item.id === hit.blockId);
      if (block) openBlock(block);
    } catch (failure) { setError(errorText(failure)); }
  }

  async function revealSearchHit(hit: SearchHit) {
    try {
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(hit.canvasId));
      const block = document.blocks.find(item => item.id === hit.blockId);
      if (!block) throw new Error('This document no longer exists on the canvas.');
      setActiveSearchId(block.id);
      showBlockOnCanvas(hit.canvasId, block.id, block.title, true);
    } catch (failure) { setError(errorText(failure)); }
  }

  function openNamedDialog(nextDialog: 'workspace' | 'canvas') {
    setDraftName('');
    setDialog(nextDialog);
  }

  function selectedOnCanvas(blocks: CanvasBlock[]) {
    setSelectedBlockIds(blocks.map(block => block.id));
    if (blocks.length !== 1 || !canvas) return;
    const block = blocks[0];
    journey.visit({ canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: block.title, viewport: journey.current?.viewport });
  }

  function summarizeSelection(blocks: CanvasBlock[]) {
    setShowChat(true);
    setAssistantView('chat');
    const names = blocks.map(block => `${block.title} (${block.id})`).join(', ');
    const text = `Summarize these selected canvas documents together: ${names}. Read each document, identify shared themes, differences, and source links. Do not edit the canvas.`;
    setChatPromptRequest(current => ({ text, sequence: (current?.sequence ?? 0) + 1 }));
  }

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
    setChatSession(value => value + 1);
    setAnswerTurns([]);
    setResearchState({ edits: emptyResearchEdits(), history: [] });
    setResearchSaveCount(0);
    setAnswerCanvasOpen(false);
    setResearchLayout('mindmap');
    setAnswerCanvasViewFocus({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  }

  function recheckAnswer() {
    if (!answerTurns.length) return;
    setShowChat(true);
    setAssistantView('chat');
    setChatPromptRequest(current => ({ text: 'What changed in the sources for this conversation, and which earlier answers need updating?',
      sequence: (current?.sequence ?? 0) + 1 }));
  }

  async function saveResearchCanvas(layout: ResearchLayout): Promise<{ id: string; name: string }> {
    const workspaceId = canvas?.workspaceId ?? workspaces[0]?.id;
    if (!workspaceId || !answerTurns.length) throw new Error('Open a workspace and ask a research question first.');
    const graph = editedResearchGraph(answerTurns, layout, researchState.edits);
    const suffix = researchSaveCount ? ` (${researchSaveCount + 1})` : '';
    const name = `Research — ${answerTurns[0].query}`.slice(0, 80 - suffix.length) + suffix;
    const created = await api<CanvasDocument>(`/workspaces/${encodeURIComponent(workspaceId)}/canvases`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
    const sourceCanvasIds = new Set(workspaces.find(workspace => workspace.id === workspaceId)?.canvases.map(item => item.id) ?? []);
    const citedIds = [...new Set(graph.blocks.flatMap(block => block.sources.map(source => source.canvasId)))]
      .filter(id => sourceCanvasIds.has(id));
    const citedCanvases = await Promise.allSettled(citedIds.map(id => api<CanvasDocument>(`/canvases/${encodeURIComponent(id)}`)));
    const availableSources = new Set(citedCanvases.flatMap((result, index) => result.status === 'fulfilled'
      ? result.value.blocks.map(block => `${citedIds[index]}:${block.id}`) : []));
    const savedBlocks = new Map<string, string>();
    for (const block of graph.blocks) {
      const saved = await api<CanvasBlock>(`/canvases/${encodeURIComponent(created.id)}/blocks`, {
        method: 'POST', body: JSON.stringify({ title: block.title, content: savedResearchContent(block),
          kind: block.kind ?? 'markdown', x: block.x, y: block.y, width: block.width, height: block.height,
          group: block.group, tags: block.tags }),
      });
      savedBlocks.set(block.id, saved.id);
    }
    for (const block of graph.blocks) {
      const links = graph.edges.filter(edge => edge.source === block.id).map(edge => savedBlocks.get(edge.target)).filter((id): id is string => Boolean(id));
      const crossLinks = block.sources.filter(source => availableSources.has(`${source.canvasId}:${source.blockId}`))
        .map(source => ({ canvasId: source.canvasId, blockId: source.blockId, relation: 'related' }));
      if (links.length || crossLinks.length) await api(`/canvases/${encodeURIComponent(created.id)}/blocks/${encodeURIComponent(savedBlocks.get(block.id)!)}`, {
        method: 'PUT', body: JSON.stringify({ links, crossLinks }),
      });
    }
    setWorkspaces(await api<WorkspaceSummary[]>('/workspaces'));
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

  function moveJourney(direction: number) {
    const place = journey.moveHistory(direction);
    if (place) navigateTo(place, false);
  }

  function saveCurrentBookmark(name: string) {
    if (!canvas) return;
    journey.addBookmark(name, { canvasId: canvas.id, canvasName: canvas.name, blockId: journey.current?.blockId,
      title: journey.current?.title, viewport: journey.current?.viewport });
  }

  return {
    workspaces, canvasId, setCanvasId, selectCanvas, canvas, crossLinkLabels, loading, error, setError, readerId, openReader, openCrossLink, showReaderDocument, closeReader, readingPath, versionBlockId,
    dialog, setDialog, draftName, setDraftName, canvasToDelete, requestDeleteCanvas, deleteCanvas, draftBlock, setDraftBlock, draftLock, takeOverLock,
    busy, settings, setSettings, showChat, setShowChat, chatSession, newChat, assistantView, setAssistantView,
    searchOpen, authRequired, signIn, focusRequest, setFocusRequest, groupFocusRequest, showBlockOnCanvas, navigateFromChat, returnFromChatNavigation, activeSearchId,
    setSearchOpen, searchQuery, setSearchQuery, searchHits, searching, searchResultQuery, uploadRef,
    groupSuggestionsOpen, setGroupSuggestionsOpen, previewGroups, setPreviewGroups, chatPromptRequest, duplicateRequest, findDuplicatesOfBlock, mergeReview, setMergeReview, mergeBusy, applyMergeReview, mergeUndo, undoMerge, viewportRequest,
    answerTurns, answerCanvasOpen, setAnswerCanvasOpen, answerCanvasViewFocus, setAnswerCanvasViewFocus,
    researchLayout, setResearchLayout, saveResearchCanvas, researchState, changeResearchEdits, undoResearchEdit, researchSaveCount,
    researchActionRequest, requestResearchAction, summarizeCurrentResearch,
    addAnswerSources, applyResearchPatch, updateAnswerText,
    settleAnswerTurn, recheckAnswer, selectedBlockIds, visibleBlockIds, setVisibleBlockIds, canvasViewFocus, setCanvasViewFocus,
    journey, navigateTo, moveJourney, saveCurrentBookmark, selectedOnCanvas, summarizeSelection, summarizeResearchSelection,
    updateBlock, deleteCanvasBlock, moveBlocks, openBlock, openVersionHistory, openNewBlock, openNamedDialog,
    saveBlock, deleteBlock, createNamed, uploadFiles, importEditedFile, saveSettings, refreshCanvasAfterChat,
    undoAgentCreatedBlock, undoAgentEditedBlock, retryConnection,
    selectSearchHit, revealSearchHit, applyInsight, openInsightBlock, startMergeDraft, receiveMergeDraft, draftGap, startReadingPath, refreshAfterVersionChange, loadCanvas,
  };
}

export type AppModel = ReturnType<typeof useAppModel>;

function LoginScreen({ onSignIn, theme, onToggleTheme }: { onSignIn: (token: string) => Promise<string>; theme: Theme; onToggleTheme: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="login-screen"><form className="login-card" onSubmit={async event => {
    event.preventDefault();
    setBusy(true);
    setError(await onSignIn(token));
    setBusy(false);
  }}>
    <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
    <BrandMark/>
    <h1>Sign in to SymbiKnow</h1>
    <p>This workspace is protected. Enter the access token your admin set as <code>SYMBIKNOW_ACCESS_TOKEN</code>.</p>
    <label>Access token<input type="password" autoFocus autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)}/></label>
    {error && <p className="login-card__error" role="alert">{error}</p>}
    <button className="primary-button" disabled={busy || !token}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></div>;
}

export function App() {
  const model = useAppModel();
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark');
  if (model.authRequired) return <LoginScreen onSignIn={model.signIn} theme={theme} onToggleTheme={toggleTheme}/>;
  return <div className={'app-shell' + (model.answerCanvasOpen ? ' is-researching' : '')}>
    <Sidebar model={model}/>
    <MainColumn model={model} theme={theme} onToggleTheme={toggleTheme}/>
    <AssistantPanel model={model}/>
    {model.readerId && <FullPageReader model={model}/>}
    {model.mergeReview && <MergeReviewDialog model={model}/>}
    {model.mergeUndo && <div role="status" style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 55, padding: '12px 16px', borderRadius: 9, background: '#edf3ff', boxShadow: '0 8px 25px #06153233' }}>
      Merged into {model.mergeUndo.title}. <button type="button" className="secondary-button" onClick={() => void model.undoMerge()} disabled={model.mergeBusy}>{model.mergeBusy ? 'Undoing…' : 'Undo merge'}</button>
    </div>}
    {model.dialog && <ModalOverlay model={model}/>}
  </div>;
}

function Sidebar({ model }: { model: AppModel }) {
  const { workspaces, canvasId, selectCanvas, requestDeleteCanvas, setDialog, openNamedDialog } = model;
  return <aside className="sidebar">
    <div className="brand"><BrandMark/><div><strong>symbiknow</strong><span>People + AI · infinite canvas</span></div></div>
    <div className="sidebar-section-label">WORKSPACES <button className="icon-button subtle" title="New workspace" aria-label="New workspace" onClick={() => openNamedDialog('workspace')}><Icon name="plus" size={16}/></button></div>
    <div className="workspace-list">{workspaces.map(workspace => <div key={workspace.id} className="workspace-group"><div className="workspace-title"><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span>{workspace.name}</span></div><div className="canvas-links">{workspace.canvases.map(item => <div className={'canvas-link-row ' + (canvasId === item.id ? 'active' : '')} key={item.id}><button className="canvas-link" onClick={() => selectCanvas(item.id)}><Icon name="grid" size={15}/><span>{item.name}</span></button><button className="canvas-link-delete" title={`Delete canvas: ${item.name}`} aria-label={`Delete canvas: ${item.name}`} onClick={() => requestDeleteCanvas(item.id, item.name, workspace.id)}><Icon name="trash" size={15}/></button></div>)}</div></div>)}</div>
    <button className="sidebar-new" onClick={() => openNamedDialog('canvas')}><Icon name="plus" size={16}/> New canvas</button>
    <div className="sidebar-spacer"/>
    <div className="sidebar-bottom"><button onClick={() => setDialog('settings')}><Icon name="settings" size={17}/><span>Settings</span></button><div className="sidebar-status" title={window.location.host}><span className="status-dot"/>{/^(localhost|127\.0\.0\.1)(:|$)/.test(window.location.host) ? 'Local workspace' : window.location.host}</div></div>
  </aside>;
}

function MainColumn({ model, theme, onToggleTheme }: { model: AppModel; theme: Theme; onToggleTheme: () => void }) {
  return <div className={`main-column${model.journey.headerHidden ? ' is-immersive' : ''}`}>
    {!model.journey.headerHidden && <Topbar model={model} theme={theme} onToggleTheme={onToggleTheme}/>}
    {model.error && <div className="global-error" role="alert"><span>{model.error}</span>
      {model.error.includes('server is unavailable') && <button type="button" onClick={model.retryConnection}>Reconnect</button>}
      <button aria-label="Dismiss error" onClick={() => model.setError('')}><Icon name="close" size={15}/></button></div>}
    <CanvasArea model={model} theme={theme}/>
  </div>;
}

function Topbar({ model, theme, onToggleTheme }: { model: AppModel; theme: Theme; onToggleTheme: () => void }) {
  const { workspaces, canvas, canvasId, setSearchOpen, setGroupSuggestionsOpen, uploadRef, uploadFiles, openNewBlock, showChat, setShowChat, setAssistantView } = model;
  const activeWorkspace = workspaces.find(workspace => workspace.id === canvas?.workspaceId || workspace.canvases.some(item => item.id === canvasId));
  return <header className="topbar">
    <div className="breadcrumb"><span>{activeWorkspace?.name || 'Workspace'}</span><Icon name="chevron" size={14}/><strong>{model.answerCanvasOpen ? 'Research canvas' : canvas?.name || 'Canvas'}</strong></div>
    <div className="top-actions">
      <button className="toolbar-button search-trigger" aria-label="Search documents" title="Search documents" onClick={() => {
        if (model.answerCanvasOpen) model.requestResearchAction('search');
        else { setGroupSuggestionsOpen(false); setSearchOpen(true); }
      }}><Icon name="search" size={17}/><span>Search documents</span><kbd>⌘ K</kbd></button>
      <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
      <button className="toolbar-button upload-trigger" aria-label="Upload files" title="Upload files" onClick={() => uploadRef.current?.click()} disabled={!canvasId}><Icon name="upload" size={17}/> Upload files</button>
      <input ref={uploadRef} type="file" accept=".md,.mdx,.html,text/markdown,text/html" multiple hidden onChange={event => {
        if (model.answerCanvasOpen) model.requestResearchAction('upload', Array.from(event.target.files ?? []));
        else void uploadFiles(event.target.files);
        event.target.value = '';
      }}/>
      <button className="primary-button" onClick={() => model.answerCanvasOpen ? model.requestResearchAction('add') : openNewBlock()} disabled={!canvasId}><Icon name="plus" size={17}/> Add block</button>
      <button className="toolbar-button insights-trigger" aria-label="Insights" title="Insights" onClick={() => {
        if (model.answerCanvasOpen) model.summarizeCurrentResearch();
        else { setShowChat(true); setAssistantView('insights'); }
      }} disabled={!canvasId}><Icon name="spark" size={17}/> Insights</button>
      <button className="toolbar-button" aria-label="Suggest groups" title="Suggest groups" onClick={() => {
        if (model.answerCanvasOpen) model.requestResearchAction('groups');
        else { setSearchOpen(false); setGroupSuggestionsOpen(true); }
      }} disabled={!canvasId}><Icon name="layers" size={17}/> Groups</button>
      <button className={'chat-toggle ' + (showChat ? 'selected' : '')} aria-label="Toggle AI assistant" title="Toggle AI assistant" onClick={() => setShowChat(value => !value)}><Icon name="spark" size={18}/></button>
    </div>
  </header>;
}

function CanvasArea({ model, theme }: { model: AppModel; theme: Theme }) {
  const { canvas, updateBlock, deleteCanvasBlock, openBlock, openNewBlock } = model;
  const selectBlock = useStableEvent((block: CanvasBlock) => openBlock(block));
  const readBlock = useStableEvent((block: CanvasBlock) => model.openReader(block.id));
  const openCrossLink = useStableEvent((canvasId: string, blockId: string) => model.openCrossLink(canvasId, blockId));
  const findDuplicates = useStableEvent((blockId: string) => model.findDuplicatesOfBlock(blockId));
  const historyBlock = useStableEvent((block: CanvasBlock) => model.openVersionHistory(block));
  const selectionChanged = useStableEvent((blocks: CanvasBlock[]) => model.selectedOnCanvas(blocks));
  const summarizeSelection = useStableEvent((blocks: CanvasBlock[]) => model.summarizeSelection(blocks));
  const viewportTimer = useRef<number | null>(null);
  const viewportPending = useRef<{ canvasId: string; viewport: CanvasViewport } | null>(null);
  const saveViewport = useStableEvent(() => {
    const pending = viewportPending.current;
    viewportTimer.current = null;
    viewportPending.current = null;
    if (pending) model.journey.updateViewport(pending.canvasId, pending.viewport);
  });
  const viewportChanged = useCallback((viewport: CanvasViewport, visibleBlockIds: string[], focus: CanvasViewFocus) => {
    if (!canvas) return;
    model.setVisibleBlockIds(visibleBlockIds);
    model.setCanvasViewFocus(current => current.level === focus.level && current.activeGroup === focus.activeGroup
      && current.visibleGroups.join('|') === focus.visibleGroups.join('|') ? current : focus);
    viewportPending.current = { canvasId: canvas.id, viewport };
    if (viewportTimer.current === null) viewportTimer.current = window.setTimeout(saveViewport, 180);
  }, [canvas, saveViewport]);
  useEffect(() => () => { if (viewportTimer.current !== null) window.clearTimeout(viewportTimer.current); }, []);
  const searchMatchIds = useMemo(() => model.searchOpen && canvas
    ? model.searchHits.filter(hit => hit.canvasId === canvas.id).map(hit => hit.blockId) : [],
  [model.searchOpen, model.searchHits, canvas?.id]);
  if (canvas) return <main className={`canvas-main${model.searchOpen ? ' is-searching' : ''}${model.groupSuggestionsOpen ? ' is-grouping' : ''}`}>
    {!model.journey.headerHidden && <div className="canvas-label"><span className="eyebrow">PEOPLE + AI · INFINITE CANVAS</span><h1>{canvas.name}</h1><p>An infinite canvas where people and AI organize ideas and build knowledge together.</p></div>}
    <MemoCanvas canvas={canvas} theme={theme} crossLinkLabels={model.crossLinkLabels} onUpdateBlock={updateBlock} onDeleteBlock={deleteCanvasBlock} onSelectBlock={selectBlock} onReadBlock={readBlock} onOpenCrossLink={openCrossLink} onFindDuplicates={findDuplicates} onHistoryBlock={historyBlock} onMoveBlocks={model.moveBlocks}
      focusRequest={model.focusRequest?.canvasId === canvas.id ? model.focusRequest : undefined}
      groupFocusRequest={model.groupFocusRequest?.canvasId === canvas.id ? model.groupFocusRequest : undefined}
      searchQuery={model.searchOpen ? model.searchQuery : ''} searchMatchIds={searchMatchIds} activeSearchId={model.activeSearchId}
      previewGroups={model.previewGroups ?? undefined} viewportRequest={model.viewportRequest}
      onViewportChange={viewportChanged} onSelectionChange={selectionChanged} onSummarizeSelection={summarizeSelection}/>
    <CanvasNavigation canvasName={canvas.name} canBack={model.journey.journey.index > 0} canForward={model.journey.journey.index < model.journey.journey.entries.length - 1}
      bookmarks={model.journey.bookmarks} recent={model.journey.recent} headerHidden={model.journey.headerHidden}
      onBack={() => model.moveJourney(-1)} onForward={() => model.moveJourney(1)} onBookmark={model.saveCurrentBookmark}
      onRemoveBookmark={model.journey.removeBookmark} onNavigate={place => model.navigateTo(place)} onToggleHeader={() => model.journey.setHeaderHidden(value => !value)}/>
    {model.searchOpen && <CanvasSearch query={model.searchQuery} hits={model.searchHits} loading={model.searching || model.searchResultQuery !== model.searchQuery.trim()} currentCanvasId={canvas.id}
      onQuery={model.setSearchQuery} onClose={() => model.setSearchOpen(false)} onReveal={hit => void model.revealSearchHit(hit)} onEdit={hit => void model.selectSearchHit(hit)}/>}
    {model.groupSuggestionsOpen && <GroupSuggestions canvas={canvas} hasApiKey={model.settings.hasJevApiKey} onOpenSettings={() => model.setDialog('settings')}
      onApply={model.moveBlocks} onClose={() => model.setGroupSuggestionsOpen(false)} onPreview={model.setPreviewGroups}/>}
    {canvas.blocks.length === 0 && <div className="canvas-empty-prompt">
      <BrandMark/>
      <span className="eyebrow">START HERE</span>
      <h2>Make knowledge together.</h2>
      <p>Add a source or an idea. Your team and its AI agents can connect, organize, and build on it across this infinite canvas.</p>
      <button className="primary-button" onClick={() => openNewBlock()}><Icon name="plus" size={17}/> Add your first block</button>
    </div>}
    {model.answerCanvasOpen && model.answerTurns.length > 0 && <AnswerCanvas turns={model.answerTurns} layout={model.researchLayout} theme={theme}
      edits={model.researchState.edits} canUndo={model.researchState.history.length > 0} historyCount={model.researchState.history.length}
      actionRequest={model.researchActionRequest}
      hasSavedCopy={model.researchSaveCount > 0}
      onEditsChange={model.changeResearchEdits} onUndo={model.undoResearchEdit}
      onLayoutChange={model.setResearchLayout} onSave={model.saveResearchCanvas}
      onOpenSavedCanvas={(id, name) => model.navigateTo({ canvasId: id, canvasName: name })}
      onClose={() => model.setAnswerCanvasOpen(false)} onRecheck={model.recheckAnswer}
      onAskSelection={model.summarizeResearchSelection}
      onViewFocusChange={focus => model.setAnswerCanvasViewFocus(current => JSON.stringify(current) === JSON.stringify(focus) ? current : focus)}
      onOpenSource={(source: AnswerSource) => model.showBlockOnCanvas(source.canvasId, source.blockId, source.title)}/>}
  </main>;
  return <EmptyCanvas model={model}/>;
}

function EmptyCanvas({ model }: { model: AppModel }) {
  const { canvasId, loading, openNamedDialog, workspaces } = model;
  const hasWorkspace = workspaces.length > 0;
  return <main className="canvas-main"><div className="empty-state">
    <div className="empty-icon"><Icon name="grid" size={30}/></div>
    <h2>{loading ? 'Loading your workspace…' : canvasId ? 'Loading canvas…' : hasWorkspace ? 'Your workspace is ready for a canvas' : 'One infinite canvas for people and AI'}</h2>
    <p>{canvasId ? 'Opening the canvas and its Markdown files.' : hasWorkspace ? 'Create a canvas to start building connected knowledge.' : 'Create a workspace and start building connected knowledge together.'}</p>
    {!canvasId && !loading && <button className="primary-button" onClick={() => openNamedDialog(hasWorkspace ? 'canvas' : 'workspace')}><Icon name="plus" size={17}/> {hasWorkspace ? 'Create canvas' : 'Create workspace'}</button>}
  </div>{model.searchOpen && <CanvasSearch query={model.searchQuery} hits={model.searchHits} loading={model.searching || model.searchResultQuery !== model.searchQuery.trim()} currentCanvasId={canvasId}
    onQuery={model.setSearchQuery} onClose={() => model.setSearchOpen(false)} onReveal={hit => void model.revealSearchHit(hit)} onEdit={hit => void model.selectSearchHit(hit)}/>}</main>;
}

function AssistantPanel({ model }: { model: AppModel }) {
  const [visited, setVisited] = useState<AssistantView[]>([]);
  useEffect(() => {
    if (model.showChat) setVisited(current => current.includes(model.assistantView) ? current : [...current, model.assistantView]);
  }, [model.showChat, model.assistantView]);
  const researchBlocks = useMemo(() => editedResearchGraph(model.answerTurns, model.researchLayout, model.researchState.edits).blocks,
    [model.answerTurns, model.researchLayout, model.researchState.edits]);
  const viewContext: ChatViewContext = useMemo(() => ({
    selectedBlockIds: model.selectedBlockIds,
    visibleBlockIds: model.answerCanvasOpen ? [] : model.visibleBlockIds,
    viewMode: model.answerCanvasOpen ? 'answer' : model.canvasViewFocus.level === 'documents' ? 'documents'
      : model.canvasViewFocus.level === 'overview' ? 'overview' : 'titles',
    activeGroup: model.answerCanvasOpen ? undefined : model.canvasViewFocus.activeGroup,
    visibleGroups: model.answerCanvasOpen ? undefined : model.canvasViewFocus.visibleGroups,
    readerBlockId: model.readerId || undefined,
    focusBlockId: model.focusRequest?.canvasId === model.canvasId ? model.focusRequest.blockId : undefined,
    searchQuery: model.searchOpen ? model.searchQuery : undefined,
    viewport: model.journey.current?.viewport,
    answerSourceIds: [...new Set(model.answerTurns.flatMap(turn => turn.sources.map(source => source.blockId)))].slice(-12),
    answerFocus: model.answerCanvasOpen ? {
      level: model.answerCanvasViewFocus.level,
      visibleQuestions: model.answerTurns.filter(turn => model.answerCanvasViewFocus.visibleAnswerIds.includes(turn.id)).map(turn => turn.query).slice(0, 8),
      visibleBlockTitles: researchBlocks.filter(block => model.answerCanvasViewFocus.visibleBlockIds?.includes(block.id)).map(block => block.title).slice(0, 12),
      visibleSourceIds: model.answerTurns.flatMap(turn => turn.sources)
        .filter(source => model.answerCanvasViewFocus.visibleSourceKeys.includes(`${source.canvasId}:${source.blockId}`))
        .map(source => source.blockId).filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 12),
      focusedQuestion: model.answerTurns.find(turn => turn.id === model.answerCanvasViewFocus.selectedAnswerId)?.query,
      focusedBlockTitle: researchBlocks.find(block => block.id === model.answerCanvasViewFocus.selectedBlockId)?.title,
      focusedSourceId: model.answerTurns.flatMap(turn => turn.sources).find(source => `${source.canvasId}:${source.blockId}` === model.answerCanvasViewFocus.selectedSourceKey)?.blockId,
    } : undefined,
  }), [model.selectedBlockIds, model.visibleBlockIds, model.readerId, model.focusRequest, model.canvasId, model.searchOpen, model.searchQuery,
    model.journey.current?.viewport, model.answerCanvasOpen, model.answerTurns, model.canvasViewFocus, model.answerCanvasViewFocus, researchBlocks]);
  const openSettings = useStableEvent(() => model.setDialog('settings'));
  const canvasChanged = useStableEvent((canvasId: string, beforeBlocks: CanvasBlock[]) => model.refreshCanvasAfterChat(canvasId, beforeBlocks));
  const showChatBlock = useStableEvent((block: CanvasBlock, targetCanvasId?: string) => model.showBlockOnCanvas(targetCanvasId ?? model.canvasId, block.id, block.title));
  const navigateFromChat = useStableEvent((target: CanvasNavigationTarget) => model.navigateFromChat(target));
  const returnFromChatNavigation = useStableEvent(() => model.returnFromChatNavigation());
  const undoAgentCreatedBlock = useStableEvent((targetCanvasId: string, block: CanvasBlock) => model.undoAgentCreatedBlock(targetCanvasId, block));
  const undoAgentEditedBlock = useStableEvent((targetCanvasId: string, edit: CanvasEdit) => model.undoAgentEditedBlock(targetCanvasId, edit));
  const changed = useStableEvent(() => model.loadCanvas().then(() => undefined));
  const applyInsight = useStableEvent((action: InsightAction) => model.applyInsight(action));
  const openInsightBlock = useStableEvent((blockId: string) => model.openInsightBlock(blockId));
  const mergeDraft = useStableEvent((item: InsightItem, action: Extract<InsightAction, { type: 'merge' }>) => model.startMergeDraft(item, action));
  const draftGap = useStableEvent((item: InsightItem) => model.draftGap(item));
  const startPath = useStableEvent((path: ReadingPath) => model.startReadingPath(path));
  const receiveMergeDraft = useStableEvent((markdown: string, request: MergeDraftRequest) => model.receiveMergeDraft(markdown, request));
  const chatMounted = visited.includes('chat') || (model.showChat && model.assistantView === 'chat');
  const insightsMounted = visited.includes('insights') || (model.showChat && model.assistantView === 'insights');
  const tasksMounted = visited.includes('tasks') || (model.showChat && model.assistantView === 'tasks');
  return <ResizableAssistant hidden={!model.showChat}>
    <div className="chat-header"><div className="assistant-avatar"><Icon name="spark" size={19}/></div><div><strong>SymbiKnow assistant</strong><span>Work with the same connected knowledge</span></div>{model.answerTurns.length > 0 && <button className="chat-header__research-return" title="Open research canvas" aria-label="Open research canvas" onClick={() => model.setAnswerCanvasOpen(true)}><Icon name="grid" size={15}/><span>Research canvas</span></button>}{model.assistantView === 'chat' && <button className="icon-button" title="New chat" aria-label="New chat" onClick={model.newChat}><Icon name="plus" size={18}/></button>}<button className="icon-button" title="Assistant settings" aria-label="Assistant settings" onClick={() => model.setDialog('settings')}><Icon name="settings" size={18}/></button></div>
    <div className="assistant-tabs" role="tablist" aria-label="Assistant views">{(['chat', 'insights', 'tasks'] as const).map(view =>
      <button key={view} role="tab" aria-selected={model.assistantView === view} onClick={() => model.setAssistantView(view)}>{view === 'chat' ? 'Chat' : view === 'insights' ? 'Insights' : 'Tasks'}</button>)}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'chat'}>{chatMounted && <Suspense fallback={<div className="assistant-view__loading">Opening chat…</div>}><ChatView key={model.chatSession} canvasId={model.canvasId} canvas={model.canvas} viewContext={viewContext} answerTurns={model.answerTurns} hasApiKey={model.settings.hasApiKey} model={model.settings.model} promptRequest={model.chatPromptRequest} onMergeDraft={receiveMergeDraft} onOpenSettings={openSettings} onCanvasChanged={canvasChanged} onShowBlock={showChatBlock} onNavigate={navigateFromChat} onReturnNavigation={returnFromChatNavigation} onUndoCreatedBlock={undoAgentCreatedBlock} onUndoEditedBlock={undoAgentEditedBlock} onCanvasSources={model.addAnswerSources} onCanvasPatch={model.applyResearchPatch} onCanvasAnswer={model.updateAnswerText} onCanvasTurnEnd={model.settleAnswerTurn} onOpenAnswerCanvas={() => model.setAnswerCanvasOpen(true)}/></Suspense>}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'insights'}>{insightsMounted && <Suspense fallback={<div className="assistant-view__loading">Opening insights…</div>}><InsightsView canvas={model.canvas} hasApiKey={model.settings.hasJevApiKey} groupBy={model.settings.groupBy} onOpenSettings={openSettings} onApply={applyInsight} onOpenBlock={openInsightBlock} onMergeDraft={mergeDraft} onDraftGap={draftGap} onStartPath={startPath} duplicateRequest={model.duplicateRequest} onChanged={changed}/></Suspense>}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'tasks'}>{tasksMounted && <Suspense fallback={<div className="assistant-view__loading">Opening tasks…</div>}><TasksView canvas={model.canvas} visible={model.showChat && model.assistantView === 'tasks'} onOpenBlock={openInsightBlock}/></Suspense>}</div>
  </ResizableAssistant>;
}
