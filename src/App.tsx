import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Canvas, type BlockPosition } from './Canvas';
import { AnswerCanvas } from './AnswerCanvas';
import type { AnswerCanvasResult, AnswerCanvasTurn, AnswerCanvasViewFocus, AnswerSource, CanvasNavigationTarget, CanvasViewFocus, ChatViewContext, ResearchCanvasPatch, ResearchLayout } from '../shared/answer-canvas';
import { editedResearchGraph, emptyResearchEdits, savedResearchContent, type ResearchCanvasEdits } from './research-edits';
import { sameDocument, type CanvasChanges, type CanvasEdit } from './canvas-changes';
import type { MergeDraftRequest } from './AIElementsChat';
import type { InvestigationResearchSnapshot } from './SavedInvestigations';
import type { FindingTaskReference } from './TasksPanel';
import { chatHistoryKey } from './chat-history';
import { ResizableAssistant } from './ResizableAssistant';
import { SymbiAvatar, type SymbiState } from './SymbiAvatar';
import type { SettingsPayload } from './SettingsPage';
import { api, authRequiredEvent, browserActor } from './api';
import { registerWebMCP } from './webmcp';
import { applyTheme, preferredTheme, type Theme } from './theme';
import { BrandMark, Icon, ThemeToggle } from './AppIcon';
import { FullPageReader, MergeReviewDialog, ModalOverlay } from './AppDialogs';
import { SmartIntakeDialog, type IntakeDraft, type IntakeSelection, type IntakeSuggestion } from './SmartIntakeDialog';
import { blockPath, importedFile, initialDraft, locationFor, starterContent, urlParam, type BlockDraft, type Dialog } from './app-model-helpers';
import { CanvasSearch } from './CanvasSearch';
import { GroupSuggestions } from './GroupSuggestions';
import { BrowseGroups } from './BrowseGroups';
import { CanvasNavigation } from './CanvasNavigation';
import { useCanvasJourney, type CanvasPlace, type CanvasViewport } from './useCanvasJourney';
import type { InsightAction, InsightItem, ReadingPath } from '../shared/insights';
import type { BlockKind, CanvasBlock, CanvasDocument, ChatSettings, SearchHit, WorkspaceSummary } from '../shared/types';

type AssistantView = 'chat' | 'insights' | 'tasks';
type ResearchActionRequest = { kind: 'add' | 'search' | 'groups' | 'upload'; sequence: number; files?: File[] };
type MergeSource = { canvasId: string; item: InsightItem; action: Extract<InsightAction, { type: 'merge' }>; blocks: CanvasBlock[] };
type MergeReview = MergeSource & { content: string };
type PendingIntake = IntakeDraft & { files: File[]; imported: { kind: BlockKind; content: string } };

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
const researchStorageKey = 'symbiknow:research-session';

function restoredResearch(): { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout } {
  const empty = { turns: [] as AnswerCanvasTurn[], edits: emptyResearchEdits(), layout: 'mindmap' as ResearchLayout };
  try {
    const value = JSON.parse(window.localStorage.getItem(researchStorageKey) ?? 'null') as Partial<typeof empty> | null;
    if (!value || !Array.isArray(value.turns) || !value.turns.every(turn => Number.isInteger(turn.id)
      && typeof turn.query === 'string' && typeof turn.answer === 'string' && Array.isArray(turn.sources))) return empty;
    const edits = value.edits;
    if (!edits || !Array.isArray(edits.added) || !edits.changed || !Array.isArray(edits.deleted)
      || !Array.isArray(edits.addedEdges) || !Array.isArray(edits.deletedEdges)) return empty;
    return { turns: value.turns.map(turn => ({ ...turn, status: turn.status === 'working' ? 'stopped' : turn.status })), edits,
      layout: ['roadmap', 'kanban', 'architecture', 'mindmap'].includes(value.layout ?? '') ? value.layout! : 'mindmap' };
  } catch { return empty; }
}

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
  const [restoredSession] = useState(restoredResearch);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [canvasId, setCanvasId] = useState('');
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [crossLinkLabels, setCrossLinkLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draftName, setDraftName] = useState('');
  const [canvasToDelete, setCanvasToDelete] = useState<{ id: string; name: string; workspaceId: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceSummary | null>(null);
  const [draftBlock, setDraftBlock] = useState<BlockDraft>(initialDraft);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(defaultSettings);
  const [showChat, setShowChat] = useState(() => !window.matchMedia?.('(max-width: 620px)').matches);
  const [documentAssistantWidth, setDocumentAssistantWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('symbiknow.assistant.document-width'));
    return Number.isFinite(saved) && saved >= 320 ? saved : Math.max(500, Math.round(window.innerWidth * .5));
  });
  const [chatSession, setChatSession] = useState(0);
  const [chatHasHistory, setChatHasHistory] = useState(false);
  const [assistantView, setAssistantView] = useState<AssistantView>('chat');
  const [findingTaskRef, setFindingTaskRef] = useState<FindingTaskReference>();
  const [activeInvestigation, setActiveInvestigation] = useState<{ id: string; canvasId: string }>();
  const [investigationOpenRequest, setInvestigationOpenRequest] = useState<{ id: string; sequence: number }>();
  const [symbiState, setSymbiState] = useState<SymbiState>('idle');
  const [insightsJevState, setInsightsJevState] = useState<SymbiState | null>(null);
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
  const [groupSuggestionsOpen, setGroupSuggestionsOpen] = useState(false);
  const [browseGroupsOpen, setBrowseGroupsOpen] = useState(false);
  const [jevGroupsRequest, setJevGroupsRequest] = useState(0);
  const [previewGroups, setPreviewGroups] = useState<Record<string, string> | null>(null);
  const [chatPromptRequest, setChatPromptRequest] = useState<{ text: string; sequence: number; mergeDraft?: MergeDraftRequest }>();
  const [assistantFocusRequest, setAssistantFocusRequest] = useState(0);
  const [answerTurns, setAnswerTurns] = useState<AnswerCanvasTurn[]>(restoredSession.turns);
  const [researchState, setResearchState] = useState<{ edits: ResearchCanvasEdits; history: ResearchCanvasEdits[] }>(() => ({ edits: restoredSession.edits, history: [] }));
  const [researchSaveCount, setResearchSaveCount] = useState(0);
  const [answerCanvasOpen, setAnswerCanvasOpen] = useState(false);
  const [researchActionRequest, setResearchActionRequest] = useState<ResearchActionRequest>();
  const [researchLayout, setResearchLayout] = useState<ResearchLayout>(restoredSession.layout);
  useEffect(() => {
    try { window.localStorage.setItem(researchStorageKey, JSON.stringify({ turns: answerTurns.slice(-30), edits: researchState.edits, layout: researchLayout })); }
    catch { /* Keep the active research session in memory if browser storage is full. */ }
  }, [answerTurns, researchState.edits, researchLayout]);
  const [answerCanvasViewFocus, setAnswerCanvasViewFocus] = useState<AnswerCanvasViewFocus>({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [visibleBlockIds, setVisibleBlockIds] = useState<string[]>([]);
  const [canvasViewFocus, setCanvasViewFocus] = useState<CanvasViewFocus>({ level: 'documents', visibleGroups: [] });
  const [duplicateRequest, setDuplicateRequest] = useState<{ canvasId: string; blockId: string; sequence: number }>();
  const [targetedRequest, setTargetedRequest] = useState<{ canvasId: string; blockIds: string[]; families: string[]; sequence: number }>();
  const [pendingIntake, setPendingIntake] = useState<PendingIntake | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
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
  const [sourceFocus, setSourceFocus] = useState<Extract<CanvasNavigationTarget, { kind: 'document' }> | null>(null);
  const researchSourceReturn = useRef(false);
  const [versionBlockId, setVersionBlockId] = useState('');
  const [versionRevision, setVersionRevision] = useState<string>();
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
    setBrowseGroupsOpen(false);
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
    setSearchError('');
    if (!query) { setSearchHits([]); setSearching(false); setSearchResultQuery(''); return; }
    setSearching(true);
    setSearchHits([]);
    let active = true;
    const timer = window.setTimeout(() => {
      api<SearchHit[]>('/search?q=' + encodeURIComponent(query))
        .then(hits => { if (active) { setSearchHits(hits); setSearchResultQuery(query); setSearching(false); setSearchError(''); } })
        .catch(failure => { if (active) { setSearchResultQuery(query); setSearching(false); setSearchError(errorText(failure)); } });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [searchQuery, searchRetry]);

  useEffect(() => {
    return registerWebMCP(() => activeCanvasId.current, () => {
      void loadCanvas().catch(failure => setError(errorText(failure)));
    });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if (event.key === 'Escape' && !dialogRef.current) { setSearchOpen(false); closeReader(); }
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
    setGroupFocusRequest(current => ({ canvasId: target.canvasId, group: target.group, sequence: (current?.sequence ?? 0) + 1 }));
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

  function openBlock(block: CanvasBlock) {
    setDraftBlock({ id: block.id, title: block.title, kind: block.kind, content: block.content, contentHash: block.contentHash });
    setDraftLock(block.lock?.owner === browserActor ? undefined : block.lock);
    setDialog('block');
  }

  function openDocumentAssistant() {
    setShowChat(true);
    setAssistantView('chat');
    setAssistantFocusRequest(current => current + 1);
  }

  function updateDocumentAssistantWidth(width: number) {
    setDocumentAssistantWidth(width);
    window.localStorage.setItem('symbiknow.assistant.document-width', String(width));
  }

  function openReader(blockId: string) {
    researchSourceReturn.current = false;
    setSourceFocus(null);
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
    setSourceFocus(null);
    setReaderId(blockId);
    window.history.replaceState(window.history.state, '', locationFor(activeCanvasId.current, blockId));
  }

  function closeReader() {
    if (researchSourceReturn.current) { returnFromChatNavigation(); return; }
    setSourceFocus(null);
    setReadingPath(null);
    if (!urlParam('doc')) { setReaderId(''); return; }
    if ((window.history.state as { reader?: boolean } | null)?.reader) window.history.back();
    else { setReaderId(''); window.history.replaceState(null, '', locationFor(activeCanvasId.current)); }
  }

  function openResearchSource(source: AnswerSource) {
    navigateFromChat({ kind: 'document', canvasId: source.canvasId, blockId: source.blockId, title: source.title,
      excerpt: source.evidence?.passage ?? source.excerpt, contentHash: source.evidence?.contentHash ?? source.contentHash });
    researchSourceReturn.current = true;
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
    setVersionRevision(undefined);
    setDialog('versions');
  }

  async function openActivityHistory(targetCanvasId: string, blockId: string, revision: string) {
    try {
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId));
      const block = document.blocks.find(item => item.id === blockId);
      if (!block) throw new Error('This document is no longer on the canvas. Its activity entry remains in the log.');
      navigateTo({ canvasId: targetCanvasId, canvasName: document.name, blockId, title: block.title });
      setCanvas(document);
      setVersionBlockId(blockId);
      setVersionRevision(revision);
      setDialog('versions');
    } catch (failure) { setError(errorText(failure)); }
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

  function requestDeleteWorkspace(workspace: WorkspaceSummary) {
    setError('');
    setWorkspaceToDelete(workspace);
    setDialog('delete-workspace');
  }

  async function deleteWorkspace() {
    if (!workspaceToDelete) return;
    const target = workspaceToDelete;
    await perform(async () => {
      await api('/workspaces/' + encodeURIComponent(target.id), { method: 'DELETE' });
      const deletedIds = new Set(target.canvases.map(item => item.id));
      for (const id of deletedIds) {
        canvasCache.current.delete(id);
        canvasEtags.current.delete(id);
        canvasLoadVersions.current.set(id, (canvasLoadVersions.current.get(id) ?? 0) + 1);
        journey.forgetCanvas(id);
      }
      if (chatReturn.current && deletedIds.has(chatReturn.current.place.canvasId)) chatReturn.current = null;
      setMergeUndo(current => current && deletedIds.has(current.canvasId) ? null : current);
      setMergeReview(current => current && deletedIds.has(current.canvasId) ? null : current);
      setSearchHits(current => current.filter(hit => !deletedIds.has(hit.canvasId)));
      const list = workspacesRef.current.filter(workspace => workspace.id !== target.id);
      workspacesRef.current = list;
      setWorkspaces(list);
      if (preferredWorkspaceId.current === target.id) preferredWorkspaceId.current = list[0]?.id ?? '';
      if (deletedIds.has(activeCanvasId.current)) {
        const nextId = list.flatMap(workspace => workspace.canvases)[0]?.id ?? '';
        window.history.replaceState(null, '', locationFor(nextId));
        activeCanvasId.current = nextId;
        setCanvasId(nextId);
        setCanvas(nextId ? canvasCache.current.get(nextId) ?? null : null);
        setReaderId('');
        setReadingPath(null);
        newChat();
        setSearchOpen(false);
        setGroupSuggestionsOpen(false);
        setFocusRequest(null);
        setGroupFocusRequest(null);
        setSelectedBlockIds([]);
        setVisibleBlockIds([]);
      }
      setWorkspaceToDelete(null);
    });
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
    if (settings.hasJevApiKey) {
      await prepareIntake(Array.from(files), 0, canvasId);
      if (uploadRef.current) uploadRef.current.value = '';
      return;
    }
    await perform(async () => {
      let last: CanvasBlock | undefined;
      for (const file of Array.from(files)) last = await uploadFile(file, canvasId);
      await loadCanvas(canvasId);
      if (last) showBlockOnCanvas(canvasId, last.id, last.title);
    });
    if (uploadRef.current) uploadRef.current.value = '';
  }

  async function prepareIntake(files: File[], index: number, sourceCanvasId: string) {
    if (index >= files.length) { setPendingIntake(null); return; }
    const file = files[index];
    try {
      const imported = await importedFile(file);
      const title = file.name.replace(/\.(md|mdx|html)$/i, '');
      setPendingIntake({ files, index, total: files.length, fileName: file.name, title, kind: imported.kind,
        imported, sourceCanvasId, suggestion: null, previewing: true, error: '', errorStage: 'preview' });
      try {
        const suggestion = await api<IntakeSuggestion>(`/canvases/${encodeURIComponent(sourceCanvasId)}/intake/preview`, {
          method: 'POST', body: JSON.stringify({ title, ...imported }),
        });
        setPendingIntake(current => current?.files === files && current.index === index
          ? { ...current, suggestion, previewing: false } : current);
      } catch (failure) {
        setPendingIntake(current => current?.files === files && current.index === index
          ? { ...current, previewing: false, error: errorText(failure), errorStage: 'preview' } : current);
      }
    } catch (failure) { setPendingIntake(null); setError(`Could not read ${file.name}: ${errorText(failure)}`); }
  }

  async function saveIntake(selection: IntakeSelection) {
    const pending = pendingIntake;
    if (!pending || intakeBusy) return;
    setIntakeBusy(true);
    let saved: CanvasBlock;
    try {
      const workspace = workspaces.find(item => item.canvases.some(entry => entry.id === pending.sourceCanvasId));
      if (!workspace?.canvases.some(entry => entry.id === selection.canvasId)) throw new Error('Choose a canvas in this workspace.');
      const target = await api<CanvasDocument>(`/canvases/${encodeURIComponent(selection.canvasId)}`);
      const known = new Set(target.blocks.filter(block => !block.archived).map(block => block.id));
      saved = await api<CanvasBlock>(`/canvases/${encodeURIComponent(selection.canvasId)}/blocks`, {
        method: 'POST', body: JSON.stringify({ title: pending.title, ...pending.imported,
          ...(selection.purpose ? { purpose: selection.purpose } : {}),
          ...(selection.workArea ? { workArea: selection.workArea } : {}), tags: selection.tags,
          links: selection.links.filter(id => known.has(id)) }),
      });
    } catch (failure) {
      setPendingIntake(current => current ? { ...current, error: errorText(failure), errorStage: 'save' } : current);
      setIntakeBusy(false);
      return;
    }
    try {
      await loadCanvas(selection.canvasId);
    } catch (failure) {
      setError(`${saved.title} was saved, but the canvas did not refresh: ${errorText(failure)}. Reopen the destination canvas to see it. Do not add this file again.`);
    }
    try {
      if (pending.index + 1 < pending.files.length) await prepareIntake(pending.files, pending.index + 1, pending.sourceCanvasId);
      else { setPendingIntake(null); showBlockOnCanvas(selection.canvasId, saved.id, saved.title); }
    } catch (failure) { setError(`${saved.title} was saved, but the next upload could not be prepared: ${errorText(failure)}. Inspect the destination canvas before retrying.`); }
    finally { setIntakeBusy(false); }
  }

  function skipIntake() {
    if (!pendingIntake || intakeBusy) return;
    void prepareIntake(pendingIntake.files, pendingIntake.index + 1, pendingIntake.sourceCanvasId);
  }

  async function saveSettings(payload: SettingsPayload) {
    setBusy(true);
    setError('');
    try {
      setSettings(await api<ChatSettings>('/settings', { method: 'PUT', body: JSON.stringify(payload) }));
      setDialog(null);
    } catch (failure) {
      throw failure;
    } finally { setBusy(false); }
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
      if (updated && id === canvasId && dialog === 'block') {
        setDraftBlock(current => {
          const original = current.id ? before.get(current.id) : undefined;
          const saved = updated.blocks.find(block => block.id === current.id);
          if (!original || !saved || (current.contentHash && current.contentHash !== original.contentHash)
            || current.title !== original.title || current.kind !== original.kind || current.content !== original.content) return current;
          return { ...current, title: saved.title, kind: saved.kind, content: saved.content, contentHash: saved.contentHash };
        });
      }
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

  function analyzeDocument(blockId: string, focus: 'related' | 'conflicts' | 'labels') {
    if (!canvas?.blocks.some(block => block.id === blockId)) return;
    const families = focus === 'related' ? ['links'] : focus === 'conflicts'
      ? ['similarity', 'stale', 'steps', 'gap'] : ['purpose', 'work_area', 'reviewer', 'tags'];
    setShowChat(true);
    setAssistantView('insights');
    setTargetedRequest(current => ({ canvasId: canvas.id, blockIds: [blockId], families,
      sequence: (current?.sequence ?? 0) + 1 }));
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

  function openSearchEvidence(hit: SearchHit) {
    if (!hit.evidence) return;
    navigateFromChat({ kind: 'document', canvasId: hit.evidence.navigation.canvasId,
      blockId: hit.evidence.navigation.blockId, title: hit.title,
      excerpt: hit.evidence.passage, contentHash: hit.evidence.contentHash });
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
    try { window.localStorage.removeItem(chatHistoryKey); window.localStorage.removeItem(researchStorageKey); }
    catch { /* Reset in-memory state even if browser storage is unavailable. */ }
    setSymbiState('idle');
    setChatSession(value => value + 1);
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
    setAnswerTurns(snapshot?.turns.map(turn => ({ ...turn, status: turn.status === 'working' ? 'stopped' : turn.status })) ?? []);
    setResearchState({ edits: snapshot?.edits ?? emptyResearchEdits(), history: [] });
    setResearchLayout(snapshot?.layout ?? 'mindmap');
    setAnswerCanvasViewFocus({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
    setAnswerCanvasOpen(Boolean(snapshot?.turns.length));
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

  const searchCurrentContentHashes = Object.fromEntries([...canvasCache.current.values(), ...(canvas ? [canvas] : [])]
    .flatMap(document => document.blocks.filter(block => block.contentHash)
      .map(block => [`${document.id}:${block.id}`, block.contentHash!] as const)));

  return {
    workspaces, canvasId, setCanvasId, selectCanvas, canvas, crossLinkLabels, loading, error, setError, readerId, sourceFocus, openReader, openCrossLink, showReaderDocument, closeReader, openResearchSource, readingPath, versionBlockId, versionRevision,
    dialog, setDialog, draftName, setDraftName, canvasToDelete, requestDeleteCanvas, deleteCanvas, workspaceToDelete, requestDeleteWorkspace, deleteWorkspace, draftBlock, setDraftBlock, draftLock, takeOverLock,
    busy, settings, setSettings, showChat, setShowChat, documentAssistantWidth, updateDocumentAssistantWidth, chatSession, newChat, chatHasHistory, setChatHasHistory, assistantView, setAssistantView, findingTaskRef, setFindingTaskRef, activeInvestigation, setActiveInvestigation, investigationOpenRequest, setInvestigationOpenRequest, assistantFocusRequest, openDocumentAssistant, symbiState, setSymbiState, insightsJevState, setInsightsJevState,
    searchOpen, authRequired, signIn, focusRequest, setFocusRequest, groupFocusRequest, showBlockOnCanvas, navigateFromChat, returnFromChatNavigation, activeSearchId,
    setSearchOpen, searchQuery, setSearchQuery, searchHits, searching, searchResultQuery, searchError, searchCurrentContentHashes,
    retrySearch: () => setSearchRetry(value => value + 1), uploadRef,
    groupSuggestionsOpen, setGroupSuggestionsOpen, browseGroupsOpen, setBrowseGroupsOpen, jevGroupsRequest, setJevGroupsRequest, previewGroups, setPreviewGroups, chatPromptRequest, duplicateRequest, targetedRequest, findDuplicatesOfBlock, analyzeDocument, mergeReview, setMergeReview, mergeBusy, applyMergeReview, mergeUndo, undoMerge, viewportRequest,
    pendingIntake, intakeBusy, saveIntake, skipIntake, cancelIntake: () => setPendingIntake(null),
    answerTurns, answerCanvasOpen, setAnswerCanvasOpen, restoreResearchSnapshot, answerCanvasViewFocus, setAnswerCanvasViewFocus,
    researchLayout, setResearchLayout, saveResearchCanvas, researchState, changeResearchEdits, undoResearchEdit, researchSaveCount,
    researchActionRequest, requestResearchAction, summarizeCurrentResearch,
    addAnswerSources, applyResearchPatch, updateAnswerText,
    settleAnswerTurn, recheckAnswer, selectedBlockIds, visibleBlockIds, setVisibleBlockIds, canvasViewFocus, setCanvasViewFocus,
    journey, navigateTo, moveJourney, saveCurrentBookmark, selectedOnCanvas, summarizeSelection, summarizeResearchSelection,
    updateBlock, deleteCanvasBlock, moveBlocks, openBlock, openVersionHistory, openActivityHistory, openNewBlock, openNamedDialog,
    saveBlock, deleteBlock, createNamed, uploadFiles, importEditedFile, saveSettings, refreshCanvasAfterChat,
    undoAgentCreatedBlock, undoAgentEditedBlock, retryConnection,
    selectSearchHit, revealSearchHit, openSearchEvidence, applyInsight, openInsightBlock, startMergeDraft, receiveMergeDraft, draftGap, startReadingPath, refreshAfterVersionChange, loadCanvas,
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
  const documentFocused = model.dialog === 'block' || (!model.dialog && Boolean(model.readerId));
  return <div className={'app-shell' + (model.answerCanvasOpen ? ' is-researching' : '')
    + (documentFocused ? ' is-document-focused' : '') + (documentFocused && model.showChat ? ' has-document-chat' : '')}
    style={{ '--document-chat-width': `${model.documentAssistantWidth}px` } as CSSProperties}>
    <Sidebar model={model}/>
    <MainColumn model={model} theme={theme} onToggleTheme={toggleTheme}/>
    <AssistantPanel model={model}/>
    {model.readerId && <FullPageReader model={model}/>}
    {model.mergeReview && <MergeReviewDialog model={model}/>}
    {model.mergeUndo && <div role="status" style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 55, padding: '12px 16px', borderRadius: 9, background: 'var(--sk-action-bg)', color: 'var(--sk-action)', boxShadow: '0 8px 25px var(--sk-shadow)' }}>
      Merged into {model.mergeUndo.title}. <button type="button" className="secondary-button" onClick={() => void model.undoMerge()} disabled={model.mergeBusy}>{model.mergeBusy ? 'Undoing…' : 'Undo merge'}</button>
    </div>}
    {model.dialog && <ModalOverlay model={model}/>}
    {model.pendingIntake && <SmartIntakeDialog key={`${model.pendingIntake.fileName}:${model.pendingIntake.index}:${model.pendingIntake.previewing}`} draft={model.pendingIntake}
      workspaces={model.workspaces} busy={model.intakeBusy} onSave={selection => void model.saveIntake(selection)} onSkip={model.skipIntake} onCancel={model.cancelIntake}/>}
  </div>;
}

function Sidebar({ model }: { model: AppModel }) {
  const { workspaces, canvasId, selectCanvas, requestDeleteCanvas, requestDeleteWorkspace, setDialog, openNamedDialog } = model;
  return <aside className="sidebar">
    <div className="brand"><BrandMark/><div><strong>symbiknow</strong><span>People + AI · infinite canvas</span></div></div>
    <div className="sidebar-section-label">WORKSPACES <button className="icon-button subtle" title="New workspace" aria-label="New workspace" onClick={() => openNamedDialog('workspace')}><Icon name="plus" size={16}/></button></div>
    <div className="workspace-list">{workspaces.map(workspace => <div key={workspace.id} className="workspace-group"><div className="workspace-title"><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span className="workspace-name">{workspace.name}</span><button type="button" className="workspace-delete" title={`Delete workspace: ${workspace.name}`} aria-label={`Delete workspace: ${workspace.name}`} onClick={() => requestDeleteWorkspace(workspace)}><Icon name="trash" size={15}/></button></div><div className="canvas-links">{workspace.canvases.map(item => <div className={'canvas-link-row ' + (canvasId === item.id ? 'active' : '')} key={item.id}><button className="canvas-link" title={`Open canvas: ${item.name}`} aria-label={`Open canvas: ${item.name}`} onClick={() => selectCanvas(item.id)}><Icon name="grid" size={15}/><span>{item.name}</span></button><button className="canvas-link-delete" title={`Delete canvas: ${item.name}`} aria-label={`Delete canvas: ${item.name}`} onClick={() => requestDeleteCanvas(item.id, item.name, workspace.id)}><Icon name="trash" size={15}/></button></div>)}</div></div>)}</div>
    <button className="sidebar-new" title="New canvas" aria-label="New canvas" onClick={() => openNamedDialog('canvas')}><Icon name="plus" size={16}/> New canvas</button>
    <div className="sidebar-spacer"/>
    <div className="sidebar-bottom"><button title="Settings" aria-label="Settings" onClick={() => setDialog('settings')}><Icon name="settings" size={17}/><span>Settings</span></button><div className="sidebar-status" title={window.location.host}><span className="status-dot"/>{/^(localhost|127\.0\.0\.1)(:|$)/.test(window.location.host) ? 'Local workspace' : window.location.host}</div></div>
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
  const { workspaces, canvas, canvasId, setSearchOpen, setGroupSuggestionsOpen, setBrowseGroupsOpen, uploadRef, uploadFiles, openNewBlock, showChat, setShowChat, setAssistantView } = model;
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
      <button className="toolbar-button" aria-label="Browse groups" title="Browse groups" onClick={() => {
        if (model.answerCanvasOpen) model.requestResearchAction('groups');
        else { setSearchOpen(false); setGroupSuggestionsOpen(false); setBrowseGroupsOpen(true); }
      }} disabled={!canvasId}><Icon name="layers" size={17}/> Browse groups</button>
      <button className={'chat-toggle ' + (showChat ? 'selected' : '')} aria-label="Toggle Symbi" title="Toggle Symbi" onClick={() => setShowChat(value => !value)}><Icon name="spark" size={18}/></button>
    </div>
  </header>;
}

function CanvasArea({ model, theme }: { model: AppModel; theme: Theme }) {
  const { canvas, updateBlock, deleteCanvasBlock, openBlock, openNewBlock } = model;
  const selectBlock = useStableEvent((block: CanvasBlock) => openBlock(block));
  const readBlock = useStableEvent((block: CanvasBlock) => model.openReader(block.id));
  const openCrossLink = useStableEvent((canvasId: string, blockId: string) => model.openCrossLink(canvasId, blockId));
  const findDuplicates = useStableEvent((blockId: string) => model.findDuplicatesOfBlock(blockId));
  const analyzeBlock = useStableEvent((blockId: string, focus: 'related' | 'conflicts' | 'labels') => model.analyzeDocument(blockId, focus));
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
  if (canvas) return <main className={`canvas-main${model.searchOpen ? ' is-searching' : ''}${model.groupSuggestionsOpen || model.browseGroupsOpen ? ' is-grouping' : ''}`}>
    {!model.journey.headerHidden && <div className="canvas-label"><span className="eyebrow">PEOPLE + AI · INFINITE CANVAS</span><h1>{canvas.name}</h1><p>An infinite canvas where people and AI organize ideas and build knowledge together.</p></div>}
    <MemoCanvas canvas={canvas} theme={theme} crossLinkLabels={model.crossLinkLabels} onUpdateBlock={updateBlock} onDeleteBlock={deleteCanvasBlock} onSelectBlock={selectBlock} onReadBlock={readBlock} onOpenCrossLink={openCrossLink} onFindDuplicates={findDuplicates} onAnalyzeBlock={analyzeBlock} onHistoryBlock={historyBlock} onMoveBlocks={model.moveBlocks}
      focusRequest={model.focusRequest?.canvasId === canvas.id ? model.focusRequest : undefined}
      groupFocusRequest={model.groupFocusRequest?.canvasId === canvas.id ? model.groupFocusRequest : undefined}
      searchQuery={model.searchOpen ? model.searchQuery : ''} searchMatchIds={searchMatchIds} activeSearchId={model.activeSearchId}
      previewGroups={model.previewGroups ?? undefined} viewportRequest={model.viewportRequest}
      onViewportChange={viewportChanged} onSelectionChange={selectionChanged} onSummarizeSelection={summarizeSelection}/>
    <CanvasNavigation canvasName={canvas.name} canBack={model.journey.journey.index > 0} canForward={model.journey.journey.index < model.journey.journey.entries.length - 1}
      bookmarks={model.journey.bookmarks} recent={model.journey.recent} headerHidden={model.journey.headerHidden}
      onBack={() => model.moveJourney(-1)} onForward={() => model.moveJourney(1)} onBookmark={model.saveCurrentBookmark}
      onRemoveBookmark={model.journey.removeBookmark} onNavigate={place => model.navigateTo(place)} onToggleHeader={() => model.journey.setHeaderHidden(value => !value)}/>
    {model.searchOpen && <CanvasSearch query={model.searchQuery} hits={model.searchHits} loading={model.searching || model.searchResultQuery !== model.searchQuery.trim()} error={model.searchError} onRetry={model.retrySearch} currentCanvasId={canvas.id} currentContentHashes={model.searchCurrentContentHashes}
      onQuery={model.setSearchQuery} onClose={() => model.setSearchOpen(false)} onReveal={hit => void model.revealSearchHit(hit)} onEdit={hit => void model.selectSearchHit(hit)} onOpenEvidence={model.openSearchEvidence}/>}
    {model.groupSuggestionsOpen && <GroupSuggestions canvas={canvas} hasApiKey={model.settings.hasJevApiKey} onOpenSettings={() => model.setDialog('settings')}
      onApply={model.moveBlocks} onClose={() => model.setGroupSuggestionsOpen(false)} onPreview={model.setPreviewGroups}/>}
    {model.browseGroupsOpen && <BrowseGroups canvas={canvas} onOpenBlock={blockId => { model.setBrowseGroupsOpen(false); model.openReader(blockId); }}
      onOrganize={() => { model.setBrowseGroupsOpen(false); model.setShowChat(true); model.setAssistantView('insights'); model.setJevGroupsRequest(value => value + 1); }}
      onClose={() => model.setBrowseGroupsOpen(false)}/>}
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
      onOpenSource={model.openResearchSource}/>}
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
  </div>{model.searchOpen && <CanvasSearch query={model.searchQuery} hits={model.searchHits} loading={model.searching || model.searchResultQuery !== model.searchQuery.trim()} error={model.searchError} onRetry={model.retrySearch} currentCanvasId={canvasId} currentContentHashes={model.searchCurrentContentHashes}
    onQuery={model.setSearchQuery} onClose={() => model.setSearchOpen(false)} onReveal={hit => void model.revealSearchHit(hit)} onEdit={hit => void model.selectSearchHit(hit)} onOpenEvidence={model.openSearchEvidence}/>}</main>;
}

function AssistantPanel({ model }: { model: AppModel }) {
  const [visited, setVisited] = useState<AssistantView[]>([]);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [newChatSaving, setNewChatSaving] = useState(false);
  const [newChatError, setNewChatError] = useState('');
  const newChatDialogRef = useRef<HTMLElement>(null);
  const newChatTriggerRef = useRef<HTMLButtonElement>(null);
  const hadNewChatPrompt = useRef(false);
  useEffect(() => {
    if (confirmNewChat) hadNewChatPrompt.current = true;
    else if (hadNewChatPrompt.current) { hadNewChatPrompt.current = false; newChatTriggerRef.current?.focus(); }
  }, [confirmNewChat]);
  useEffect(() => {
    if (model.showChat) setVisited(current => current.includes(model.assistantView) ? current : [...current, model.assistantView]);
  }, [model.showChat, model.assistantView]);
  const researchBlocks = useMemo(() => editedResearchGraph(model.answerTurns, model.researchLayout, model.researchState.edits).blocks,
    [model.answerTurns, model.researchLayout, model.researchState.edits]);
  const editingBlock = model.dialog === 'block' && model.draftBlock.id
    ? model.canvas?.blocks.find(block => block.id === model.draftBlock.id) : undefined;
  const documentBlockId = model.dialog === 'block' ? model.draftBlock.id : model.readerId || undefined;
  const editorHasUnsavedChanges = model.dialog === 'block' && (!editingBlock || model.draftBlock.title !== editingBlock.title
    || model.draftBlock.kind !== editingBlock.kind || model.draftBlock.content !== editingBlock.content);
  const viewContext: ChatViewContext = useMemo(() => ({
    selectedBlockIds: model.dialog === 'block' ? documentBlockId ? [documentBlockId] : []
      : documentBlockId ? [documentBlockId] : model.selectedBlockIds,
    visibleBlockIds: model.dialog === 'block' ? documentBlockId ? [documentBlockId] : []
      : documentBlockId ? [documentBlockId] : model.answerCanvasOpen ? [] : model.visibleBlockIds,
    viewMode: documentBlockId ? 'documents' : model.dialog === 'block' ? 'overview'
      : model.answerCanvasOpen ? 'answer' : model.canvasViewFocus.level === 'documents' ? 'documents'
      : model.canvasViewFocus.level === 'overview' ? 'overview' : 'titles',
    activeGroup: model.answerCanvasOpen ? undefined : model.canvasViewFocus.activeGroup,
    visibleGroups: model.answerCanvasOpen ? undefined : model.canvasViewFocus.visibleGroups,
    readerBlockId: documentBlockId,
    editingBlockId: editingBlock?.id,
    editorHasUnsavedChanges: model.dialog === 'block' ? editorHasUnsavedChanges : undefined,
    editorDraft: editorHasUnsavedChanges ? { title: model.draftBlock.title, kind: model.draftBlock.kind,
      content: model.draftBlock.content.slice(0, 16000), truncated: model.draftBlock.content.length > 16000 } : undefined,
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
  }), [model.selectedBlockIds, model.visibleBlockIds, model.dialog, model.draftBlock, documentBlockId, editingBlock?.id, editorHasUnsavedChanges,
    model.focusRequest, model.canvasId, model.searchOpen, model.searchQuery, model.journey.current?.viewport,
    model.answerCanvasOpen, model.answerTurns, model.canvasViewFocus, model.answerCanvasViewFocus, researchBlocks]);
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
  const createFindingTask = useStableEvent((item: InsightItem) => {
    if (!model.canvas) return;
    model.setFindingTaskRef({ id: item.id, title: item.title, canvasId: model.canvas.id, blockIds: item.blockIds,
      detail: item.detail, evidence: item.evidence, references: item.references,
      ...(model.activeInvestigation?.canvasId === model.canvas.id ? { investigationId: model.activeInvestigation.id } : {}),
      suggestedOwner: item.action?.type === 'update' ? item.action.patch.reviewer : undefined });
    model.setAssistantView('tasks');
  });
  const openFindingFromTask = useStableEvent((ref: FindingTaskReference) => {
    model.setFindingTaskRef(ref);
    model.setAssistantView('insights');
    if (model.canvas?.id === ref.canvasId && ref.blockIds.length) model.analyzeDocument(ref.blockIds[0], 'related');
  });
  const openInvestigationFromTask = useStableEvent((id: string) => {
    model.setAssistantView('chat');
    model.setInvestigationOpenRequest(current => ({ id, sequence: (current?.sequence ?? 0) + 1 }));
  });
  const receiveMergeDraft = useStableEvent((markdown: string, request: MergeDraftRequest) => model.receiveMergeDraft(markdown, request));
  const startNewChat = () => {
    if (model.chatHasHistory || model.answerTurns.length) { setNewChatError(''); setConfirmNewChat(true); }
    else model.newChat();
  };
  const discardAndStart = () => { model.newChat(); setConfirmNewChat(false); };
  const saveAndStart = async () => {
    setNewChatSaving(true); setNewChatError('');
    try { await model.saveResearchCanvas(model.researchLayout); discardAndStart(); }
    catch (failure) { setNewChatError(errorText(failure)); }
    finally { setNewChatSaving(false); }
  };
  const chatMounted = visited.includes('chat') || (model.showChat && model.assistantView === 'chat');
  const insightsMounted = visited.includes('insights') || (model.showChat && model.assistantView === 'insights');
  const tasksMounted = visited.includes('tasks') || (model.showChat && model.assistantView === 'tasks');
  const visibleSymbiState = model.assistantView === 'insights' && model.insightsJevState ? model.insightsJevState : model.symbiState;
  const symbiCaption: Record<SymbiState, string> = {
    idle: 'Your guide to the connected canvas', thinking: 'Thinking it through…',
    searching: 'Searching documents…', reading: 'Reading the source…', working: 'Updating the canvas…',
    navigating: 'Opening the right place…', tooling: 'Working with a tool…', speaking: 'Putting the answer together…',
    done: 'Answer ready', error: 'Needs a retry', 'jev-routing': 'Jev is choosing the right context…',
    'jev-analyzing': 'Jev is analyzing the canvas…', 'jev-verifying': 'Jev is checking the answer…',
    'jev-applying': 'Jev is applying your changes…',
  };
  return <ResizableAssistant hidden={!model.showChat}
    documentWidth={model.dialog === 'block' || (!model.dialog && model.readerId) ? model.documentAssistantWidth : undefined}
    onDocumentWidthChange={model.updateDocumentAssistantWidth}>
    <div className="chat-header"><SymbiAvatar state={visibleSymbiState}/><div><strong>Symbi</strong><span>{symbiCaption[visibleSymbiState]}</span></div>{model.answerTurns.length > 0 && <button className="chat-header__research-return" title="Open research canvas" aria-label="Open research canvas" onClick={() => model.setAnswerCanvasOpen(true)}><Icon name="grid" size={15}/><span>Research canvas</span></button>}{model.assistantView === 'chat' && <button ref={newChatTriggerRef} className="icon-button" title="New chat" aria-label="New chat" onClick={startNewChat}><Icon name="plus" size={18}/></button>}<button className="icon-button" title="Symbi settings" aria-label="Symbi settings" onClick={() => model.setDialog('settings')}><Icon name="settings" size={18}/></button><button className="icon-button" title="Close Symbi panel" aria-label="Close Symbi panel" onClick={() => model.setShowChat(false)}><Icon name="close" size={18}/></button></div>
    <div className="assistant-tabs" role="tablist" aria-label="Assistant views">{(['chat', 'insights', 'tasks'] as const).map(view =>
      <button key={view} role="tab" aria-selected={model.assistantView === view} onClick={() => model.setAssistantView(view)}>{view === 'chat' ? 'Chat' : view === 'insights' ? 'Insights' : 'Tasks'}</button>)}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'chat'}>{chatMounted && <Suspense fallback={<div className="assistant-view__loading">Opening chat…</div>}><ChatView key={model.chatSession} canvasId={model.canvasId} canvas={model.canvas} viewContext={viewContext} answerTurns={model.answerTurns} researchEdits={model.researchState.edits} researchLayout={model.researchLayout} investigationOpenRequest={model.investigationOpenRequest} onActiveInvestigationChange={model.setActiveInvestigation} hasApiKey={model.settings.hasApiKey} jevAvailable={model.settings.hasJevApiKey && (model.settings.agentPlugins?.includes('jev_insights') ?? true)} model={model.settings.model} promptRequest={model.chatPromptRequest} focusRequest={model.assistantFocusRequest} onMergeDraft={receiveMergeDraft} onOpenSettings={openSettings} onCanvasChanged={canvasChanged} onShowBlock={showChatBlock} onNavigate={navigateFromChat} onReturnNavigation={returnFromChatNavigation} onUndoCreatedBlock={undoAgentCreatedBlock} onUndoEditedBlock={undoAgentEditedBlock} onCanvasSources={model.addAnswerSources} onCanvasPatch={model.applyResearchPatch} onCanvasAnswer={model.updateAnswerText} onCanvasTurnEnd={model.settleAnswerTurn} onRestoreResearch={model.restoreResearchSnapshot} onOpenAnswerCanvas={() => model.setAnswerCanvasOpen(true)} onAvatarStateChange={model.setSymbiState} onHistoryChange={model.setChatHasHistory}/></Suspense>}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'insights'}>{insightsMounted && <Suspense fallback={<div className="assistant-view__loading">Opening insights…</div>}><InsightsView canvas={model.canvas} hasApiKey={model.settings.hasJevApiKey} groupBy={model.settings.groupBy} onOpenSettings={openSettings} onApply={applyInsight} onOpenBlock={openInsightBlock} onMergeDraft={mergeDraft} onDraftGap={draftGap} onStartPath={startPath} duplicateRequest={model.duplicateRequest} targetedRequest={model.targetedRequest} onChanged={changed} onJevActivityChange={model.setInsightsJevState} onCreateTask={createFindingTask} linkedFinding={model.findingTaskRef} groupsRequest={model.jevGroupsRequest}
      onBrowseGroups={() => { model.setGroupSuggestionsOpen(false); model.setBrowseGroupsOpen(true); }}
      onAdvancedGrouping={() => { model.setBrowseGroupsOpen(false); model.setGroupSuggestionsOpen(true); }}/></Suspense>}</div>
    <div className="assistant-view" hidden={model.assistantView !== 'tasks'}>{tasksMounted && <Suspense fallback={<div className="assistant-view__loading">Opening tasks…</div>}><TasksView canvas={model.canvas} visible={model.showChat && model.assistantView === 'tasks'} onOpenBlock={openInsightBlock} findingRef={model.findingTaskRef} onFindingTaskCreated={() => model.setFindingTaskRef(undefined)} onOpenFinding={openFindingFromTask} onOpenInvestigation={openInvestigationFromTask}/></Suspense>}</div>
    {confirmNewChat && <div className="ai-chat__new-session-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmNewChat(false); }}>
      <section ref={newChatDialogRef} className="ai-chat__new-session" role="alertdialog" aria-modal="true" aria-label="Start a new chat" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setConfirmNewChat(false); }
        if (event.key !== 'Tab') return;
        const buttons = [...(newChatDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }}>
        <h2>Start a new chat?</h2><p>This clears the conversation, temporary research canvas, and proposal or Undo controls in this chat. Saved documents stay in place.</p>
        {newChatError && <p role="alert">{newChatError}</p>}
        <div className="ai-chat__new-session-actions"><button type="button" className="secondary-button" autoFocus disabled={newChatSaving} onClick={() => setConfirmNewChat(false)}>Keep working</button>
          {model.answerTurns.length > 0 && <button type="button" className="secondary-button" disabled={newChatSaving} onClick={() => void saveAndStart()}>{newChatSaving ? 'Saving…' : 'Save research and start'}</button>}
          <button type="button" className="danger-button" disabled={newChatSaving} onClick={discardAndStart}>Discard and start</button></div>
      </section></div>}
  </ResizableAssistant>;
}
