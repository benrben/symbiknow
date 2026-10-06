import { type FormEvent } from 'react';
import type { CanvasDocument, WorkspaceSummary } from '../shared/types';
import { api } from './api';
import type { CanvasDataActions } from './app-canvas-data';
import type { DocumentActions } from './app-documents';
import { locationFor } from './app-model-helpers';
import type { ResearchSessionActions } from './app-research';
import type { AppState } from './app-state';
import { useWorkspaceCreationOwnership } from './workspace-creation-ownership';

function firstRemainingCanvas(list: WorkspaceSummary[]) {
  return list.flatMap(workspace => workspace.canvases)[0]?.id ?? '';
}

export function useWorkspaceActions(state: AppState, data: CanvasDataActions, documents: DocumentActions, research: ResearchSessionActions) {
  const {
    workspaces, setWorkspaces, setCanvasId, canvas, setCanvas, setError, dialog, setDialog, draftName, setDraftName,
    canvasToDelete, setCanvasToDelete, workspaceToDelete, setWorkspaceToDelete, setSearchOpen, setSearchHits,
    setAnswerCanvasOpen, setSelectedBlockIds, setVisibleBlockIds, journey, setFocusRequest, setGroupFocusRequest, setReaderId,
    canvasLoadVersions, activeCanvasId, workspacesRef, preferredWorkspaceId, chatReturn,
  } = state;
  const { refreshWorkspaces } = data;
  const { perform } = documents;
  const { newChat } = research;
  const captureCreation = useWorkspaceCreationOwnership(state);

  async function createWorkspace(name: string) {
    const ownsCreation = captureCreation();
    const created = await api<WorkspaceSummary>('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    const firstCanvas = await api<CanvasDocument>('/workspaces/' + encodeURIComponent(created.id) + '/canvases', { method: 'POST', body: JSON.stringify({ name: 'Untitled canvas' }) });
    await refreshWorkspaces(firstCanvas.id, ownsCreation);
  }

  async function createCanvas(name: string) {
    const ownsCreation = captureCreation();
    const workspaceId = canvas?.workspaceId || preferredWorkspaceId.current || workspaces[0]?.id;
    if (!workspaceId) throw new Error('Create a workspace first.');
    const created = await api<CanvasDocument>('/workspaces/' + encodeURIComponent(workspaceId) + '/canvases', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshWorkspaces(created.id, ownsCreation);
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

  function forgetCanvas(id: string) {
    canvasLoadVersions.current.set(id, (canvasLoadVersions.current.get(id) ?? 0) + 1);
    journey.forgetCanvas(id);
  }

  function removeDeletedCanvasReferences(deletedIds: Set<string>) {
    if (chatReturn.current && deletedIds.has(chatReturn.current.place.canvasId)) chatReturn.current = null;
    setSearchHits(current => current.filter(hit => !deletedIds.has(hit.canvasId)));
  }

  function showCanvasAfterDeletion(nextId: string) {
    window.history.replaceState(null, '', locationFor(nextId));
    activeCanvasId.current = nextId;
    setCanvasId(nextId);
    setCanvas(null);
    setReaderId('');
    setFocusRequest(null);
    setGroupFocusRequest(null);
    setSelectedBlockIds([]);
  }

  async function deleteWorkspace() {
    if (!workspaceToDelete) return;
    const target = workspaceToDelete;
    await perform(async () => {
      await api('/workspaces/' + encodeURIComponent(target.id), { method: 'DELETE' });
      const deletedIds = new Set(target.canvases.map(item => item.id));
      deletedIds.forEach(forgetCanvas);
      removeDeletedCanvasReferences(deletedIds);
      const list = workspacesRef.current.filter(workspace => workspace.id !== target.id);
      workspacesRef.current = list;
      setWorkspaces(list);
      if (preferredWorkspaceId.current === target.id) preferredWorkspaceId.current = list[0]?.id ?? '';
      if (deletedIds.has(activeCanvasId.current)) {
        const nextId = firstRemainingCanvas(list);
        showCanvasAfterDeletion(nextId);
        newChat();
        setSearchOpen(false);
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
      forgetCanvas(target.id);
      removeDeletedCanvasReferences(new Set([target.id]));
      const list = workspacesRef.current.map(workspace => ({ ...workspace,
        canvases: workspace.canvases.filter(item => item.id !== target.id) }));
      workspacesRef.current = list;
      setWorkspaces(list);
      if (activeCanvasId.current === target.id) {
        preferredWorkspaceId.current = target.workspaceId;
        const next = list.find(workspace => workspace.id === target.workspaceId)?.canvases[0]
          ?? list.flatMap(workspace => workspace.canvases)[0];
        const nextId = next?.id ?? '';
        showCanvasAfterDeletion(nextId);
        setAnswerCanvasOpen(false);
      }
      setCanvasToDelete(null);
    });
  }

  async function createNamed(event: FormEvent) {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    const ownsCreation = captureCreation();
    await perform(async () => {
      if (dialog === 'workspace') await createWorkspace(name);
      if (dialog === 'canvas') await createCanvas(name);
      if (ownsCreation()) setDraftName('');
    });
  }

  return { createWorkspace, createCanvas, requestDeleteCanvas, requestDeleteWorkspace, deleteWorkspace, deleteCanvas, createNamed };
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;
