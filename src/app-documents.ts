import { useCallback, useRef, type FormEvent } from 'react';
import type { CanvasBlock, CanvasDocument, ChatSettings } from '../shared/types';
import { api, browserActor } from './api';
import type { CanvasDataActions } from './app-canvas-data';
import { blockPath, importedFile, starterContent } from './app-model-helpers';
import type { CanvasNavigationActions } from './app-navigation';
import type { AppState } from './app-state';
import { errorText, replaceBlock } from './app-state-helpers';
import { type BlockPosition } from './Canvas';
import type { SettingsPayload } from './SettingsPage';

export function useDocumentActions(state: AppState, data: CanvasDataActions, navigation: CanvasNavigationActions) {
  const {
    canvasId, setCanvas, setError, setDialog, setDraftName, draftBlock, setDraftBlock, setBusy, setSettings,
    setDraftLock, setVersionBlockId, setVersionRevision, activeCanvasId,
  } = state;
  const { loadCanvas } = data;
  const { navigateTo, showBlockOnCanvas } = navigation;
  const openingBlock = useRef(0);

  function ownsDialog() {
    const dialog = state.dialogVersion.current;
    return () => state.dialogVersion.current === dialog;
  }

  async function perform(action: () => Promise<void>) {
    const isCurrent = ownsDialog();
    setBusy(true);
    setError('');
    try { await action(); if (isCurrent()) setDialog(null); }
    catch (failure) { if (isCurrent()) setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  function openNewBlock() {
    openingBlock.current++;
    setDraftBlock({ title: 'Untitled note', kind: 'markdown', content: starterContent.markdown });
    setDialog('block');
  }

  function editBlock(block: CanvasBlock) {
    setDraftBlock({ id: block.id, title: block.title, kind: block.kind, content: block.content, contentHash: block.contentHash });
    setDraftLock(block.lock?.owner === browserActor ? undefined : block.lock);
    setDialog('block');
  }

  function openBlock(block: CanvasBlock) {
    const request = ++openingBlock.current;
    if (block.contentLoaded !== false) { editBlock(block); return; }
    return openUnloadedBlock(block, request);
  }

  async function openUnloadedBlock(block: CanvasBlock, request: number) {
    const id = activeCanvasId.current;
    const navigation = state.navigationVersion.current;
    const ownsDialog = state.dialogVersion.current;
    const isCurrent = () => request === openingBlock.current && state.navigationVersion.current === navigation
      && state.dialogVersion.current === ownsDialog && activeCanvasId.current === id;
    try {
      const document = await api<CanvasBlock>(blockPath(id, block.id), { cache: 'no-store' });
      if (!isCurrent()) return;
      setCanvas(current => replaceBlock(current, id, block.id, document));
      editBlock(document);
    } catch (failure) { if (isCurrent()) setError(errorText(failure)); }
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
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId) + '?summary=1', { cache: 'no-store' });
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
    const isCurrent = ownsDialog();
    const navigation = state.navigationVersion.current;
    await perform(async () => {
      const payload = blockPayload();
      if (draftBlock.id) await api<CanvasBlock>(blockPath(canvasId, draftBlock.id), { method: 'PUT', body: JSON.stringify(payload) });
      else {
        const created = await api<CanvasBlock>('/canvases/' + encodeURIComponent(canvasId) + '/blocks', { method: 'POST', body: JSON.stringify(payload) });
        if (activeCanvasId.current === canvasId && isCurrent() && state.navigationVersion.current === navigation) showBlockOnCanvas(canvasId, created.id, created.title);
      }
      await loadCanvas(canvasId);
    });
  }

  function blockPayload() {
    return { title: draftBlock.title.trim(), kind: draftBlock.kind, content: draftBlock.content,
      ...(draftBlock.id && draftBlock.contentHash ? { expectedContentHash: draftBlock.contentHash } : {}) };
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

  async function importEditedFile(file: File) {
    try {
      const imported = await importedFile(file);
      setDraftBlock(current => ({ ...current, content: imported.content, kind: /\.md$/i.test(file.name) ? current.kind : imported.kind }));
    } catch (failure) { setError(errorText(failure)); }
  }

  async function saveSettings(payload: SettingsPayload) {
    const isCurrent = ownsDialog();
    setBusy(true);
    setError('');
    try {
      setSettings(await api<ChatSettings>('/settings', { method: 'PUT', body: JSON.stringify(payload) }));
      if (isCurrent()) setDialog(null);
    } catch (failure) {
      throw failure;
    } finally { setBusy(false); }
  }

  function openNamedDialog(nextDialog: 'workspace' | 'canvas') {
    setDraftName('');
    setDialog(nextDialog);
  }

  return { perform, openNewBlock, openBlock, takeOverLock, moveBlocks, openVersionHistory, openActivityHistory, saveBlock, updateBlock, deleteCanvasBlock, deleteBlock, importEditedFile, saveSettings, openNamedDialog };
}

export type DocumentActions = ReturnType<typeof useDocumentActions>;
