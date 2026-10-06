import { useEffect, useRef } from 'react';
import type { CanvasBlock, CanvasDocument, ChatSettings, WorkspaceSummary } from '../shared/types';
import { api, authRequiredEvent } from './api';
import { blockPath, locationFor, urlParam } from './app-model-helpers';
import type { AppState } from './app-state';
import { errorText } from './app-state-helpers';
import { registerWebMCP } from './webmcp';

function firstCanvasId(list: WorkspaceSummary[]) { return list[0]?.canvases[0]?.id || ''; }
function beginCanvasLoad(versions: Map<string, number>, id: string): number {
  const version = (versions.get(id) ?? 0) + 1;
  versions.set(id, version);
  return version;
}
function reusedBlock(previous: CanvasBlock | undefined, next: CanvasBlock): CanvasBlock {
  // Unversioned summaries must still refresh their visible document bodies.
  if (next.contentLoaded === false && !next.contentVersion) return next;
  return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
function sameBlocks(previous: CanvasBlock[], next: CanvasBlock[]): boolean {
  return previous.length === next.length && next.every((block, index) => block === previous[index]);
}
function reusedCanvas(previous: CanvasDocument | null, next: CanvasDocument): CanvasDocument {
  if (!previous || previous.id !== next.id) return next;
  const existing = new Map(previous.blocks.map(block => [block.id, block]));
  const refreshed = next.blocks.map(block => reusedBlock(existing.get(block.id), block));
  const blocks = sameBlocks(previous.blocks, refreshed) ? previous.blocks : refreshed;
  if (blocks === previous.blocks && JSON.stringify({ ...previous, blocks: [] }) === JSON.stringify({ ...next, blocks: [] })) return previous;
  return { ...next, blocks };
}
function readerOnCanvas(document: CanvasDocument, current: string, requested: string): string {
  const id = requested || current;
  return document.blocks.some(block => block.id === id) ? id : '';
}

function initialCanvasId(list: WorkspaceSummary[], requested: string) {
  const known = list.some(workspace => workspace.canvases.some(item => item.id === requested));
  return known ? requested : firstCanvasId(list);
}

function initialWorkspaceId(list: WorkspaceSummary[], canvasId: string) {
  return list.find(workspace => workspace.canvases.some(item => item.id === canvasId))?.id ?? list[0]?.id ?? '';
}

export function useCanvasData(state: AppState) {
  const {
    setWorkspaces, canvasId, setCanvasId, canvas, setCanvas, setCrossLinkLabels, setLoading, error, setError,
    setSettings, setAuthRequired, setReaderId, canvasLoadVersions, lastInteraction,
    activeCanvasId, workspacesRef, preferredWorkspaceId, dialogRef, session, setSession,
  } = state;

  const editingBlockId = useRef(state.draftBlock.id);
  editingBlockId.current = state.draftBlock.id;

  async function refreshWorkspaces(preferredCanvasId: string, ownsSelection = () => true) {
    const list = await api<WorkspaceSummary[]>('/workspaces');
    setWorkspaces(list);
    if (!ownsSelection()) return;
    preferredWorkspaceId.current = list.find(workspace => workspace.canvases.some(item => item.id === preferredCanvasId))?.id ?? preferredWorkspaceId.current;
    activeCanvasId.current = preferredCanvasId;
    setCanvasId(preferredCanvasId);
    setCanvas(current => current?.id === preferredCanvasId ? current : null);
  }

  async function refreshAfterVersionChange() { await loadCanvas(activeCanvasId.current); }

  async function loadEditorContent(document: CanvasDocument) {
    const editing = dialogRef.current === 'block' ? editingBlockId.current : undefined;
    if (!editing || activeCanvasId.current !== document.id) return;
    if (!document.blocks.some(block => block.id === editing)) return;
    const block = await api<CanvasBlock>(blockPath(document.id, editing), { cache: 'no-store' });
    document.blocks = document.blocks.map(item => item.id === editing ? block : item);
  }

  async function loadCanvas(id = activeCanvasId.current) {
    if (!id) { setCanvas(null); return null; }
    const version = beginCanvasLoad(canvasLoadVersions.current, id);
    const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(id) + '?summary=1', { cache: 'no-store' });
    if (version !== canvasLoadVersions.current.get(id)) return null;
    await loadEditorContent(document);
    if (version !== canvasLoadVersions.current.get(id)) return null;
    if (activeCanvasId.current === id) setCanvas(current => reusedCanvas(current, document));
    return document;
  }

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
        const initialId = initialCanvasId(list, urlParam('canvas'));
        preferredWorkspaceId.current = initialWorkspaceId(list, initialId);
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
    setCanvas(current => current?.id === canvasId ? current : null);
    if (urlParam('canvas') !== canvasId) {
      window.history.replaceState(null, '', locationFor(canvasId));
      setReaderId('');
    }
    loadCanvas(canvasId)
      .then(document => {
        if (!active || !document) return;
        const doc = urlParam('doc');
        setReaderId(current => readerOnCanvas(document, current, doc));
      })
      .catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  // Authentication and Retry must reload even when the canvas identifier stays the same.
  }, [canvasId, session]);

  const crossLinkKey = canvas?.blocks.flatMap(block => block.crossLinks ?? [])
    .map(link => `${link.canvasId}:${link.blockId}`).sort().join('\u0000') ?? '';

  useEffect(() => {
    const links = canvas?.blocks.flatMap(block => block.crossLinks ?? []) ?? [];
    if (!links.length) { setCrossLinkLabels({}); return; }
    let active = true;
    const targetCanvasIds = [...new Set(links.map(link => link.canvasId))];
    void Promise.all(targetCanvasIds.map(async id => {
      return api<CanvasDocument>('/canvases/' + encodeURIComponent(id) + '?summary=1', { cache: 'no-store' }).catch(() => null);
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
    return registerWebMCP(() => activeCanvasId.current, () => {
      void loadCanvas().catch(failure => setError(errorText(failure)));
    });
  }, []);

  async function signIn(token: string): Promise<string> {
    try {
      await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
      setAuthRequired(false);
      setError('');
      setSession(value => value + 1);
      return '';
    } catch (failure) { return errorText(failure); }
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

  return { refreshWorkspaces, refreshAfterVersionChange, loadCanvas, signIn, retryConnection };
}

export type CanvasDataActions = ReturnType<typeof useCanvasData>;
