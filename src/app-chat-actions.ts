import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import { documentReviewState } from '../shared/document-state';
import { useChatRefreshOwnership } from './app-chat-refresh-ownership';
import type { CanvasDataActions } from './app-canvas-data';
import type { AppState } from './app-state';
import { errorText } from './app-state-helpers';
import { sameDocument, type CanvasChanges, type CanvasEdit } from './canvas-changes';

function sameDraftAsSaved(draft: AppState['draftBlock'], saved: CanvasBlock) {
  if (draft.contentHash && draft.contentHash !== saved.contentHash) return false;
  return (['title', 'kind', 'content'] as const).every(field => draft[field] === saved[field]);
}

function syncUntouchedDraft(draft: AppState['draftBlock'], before: Map<string, CanvasBlock>, updated: CanvasDocument) {
  const original = draft.id ? before.get(draft.id) : undefined;
  const saved = updated.blocks.find(block => block.id === draft.id);
  if (!original || original.contentLoaded === false || !saved || !sameDraftAsSaved(draft, original)) return draft;
  return { ...draft, title: saved.title, kind: saved.kind, content: saved.content, contentHash: saved.contentHash };
}

function agentCreatedDocumentChanged(current: CanvasBlock, created: CanvasBlock, latest: CanvasDocument) {
  if (created.contentHash && current.contentHash !== created.contentHash) return true;
  return !sameDocument(current, created)
    || latest.blocks.some(block => block.id !== created.id && block.links.includes(created.id));
}

function requireUnchangedAgentEdit(current: CanvasBlock | undefined, edit: CanvasEdit): asserts current is CanvasBlock {
  if (!current || !sameDocument(current, edit.after) || current.contentHash !== edit.after.contentHash)
    throw new Error('This document changed again. Review its history before restoring it.');
  if (JSON.stringify(edit.before.quality) !== JSON.stringify(edit.after.quality))
    throw new Error('This quality change needs review in document history.');
}

function restoreAgentEditPayload(before: CanvasBlock, contentHash: string | undefined) {
  return {
    expectedContentHash: contentHash, title: before.title, kind: before.kind, content: before.content,
    x: before.x, y: before.y, width: before.width, height: before.height,
    links: before.links, linkTypes: before.linkTypes ?? {}, crossLinks: before.crossLinks ?? [],
    ...restoreDocumentLabels(before),
    message: `Undo agent edit to ${before.title}`,
  };
}

function restoreDocumentLabels(before: CanvasBlock) {
  return { archived: before.archived ?? false, stale: before.stale ?? false, tags: before.tags ?? [],
    ...restoreDocumentClassification(before) };
}

function restoreDocumentClassification(before: CanvasBlock) {
  return { purpose: before.purpose ?? '', reviewer: before.reviewer ?? '', workArea: before.workArea ?? '', group: before.group ?? null };
}

function agentCanvasChanges(updated: CanvasDocument, before: Map<string, CanvasBlock>): CanvasChanges {
  return { created: updated.blocks.filter(block => !before.has(block.id)),
    updated: updated.blocks.flatMap(block => {
      const original = before.get(block.id);
      return original && original.contentLoaded !== false && !sameDocument(original, block) ? [{ before: original, after: block }] : [];
    }) };
}

export function useChatCanvasActions(state: AppState, data: CanvasDataActions) {
  const { setError, dialog, setDraftBlock, setShowChat, setAssistantView, setChatPromptRequest } = state;
  const { loadCanvas } = data;
  const ownsRefresh = useChatRefreshOwnership(state);

  function refreshUntouchedDraft(updated: CanvasDocument, before: Map<string, CanvasBlock>, isCurrent: () => boolean) {
    if (dialog !== 'block' || !isCurrent()) return;
    setDraftBlock(current => syncUntouchedDraft(current, before, updated));
  }

  async function refreshCanvasAfterChat(id: string, beforeBlocks: CanvasBlock[]): Promise<CanvasChanges> {
    if (!id) return { created: [], updated: [] };
    const isCurrent = ownsRefresh(id);
    try {
      const updated = await api<CanvasDocument>('/canvases/' + encodeURIComponent(id), { cache: 'no-store' });
      await loadCanvas(id);
      const before = new Map(beforeBlocks.map(block => [block.id, block]));
      refreshUntouchedDraft(updated, before, isCurrent);
      return agentCanvasChanges(updated, before);
    } catch (failure) { if (isCurrent()) setError(errorText(failure)); return { created: [], updated: [] }; }
  }

  async function undoAgentCreatedBlock(targetCanvasId: string, created: CanvasBlock): Promise<void> {
    if (created.incarnation && created.sourceGeneration) {
      await api(`/canvases/${encodeURIComponent(targetCanvasId)}/jev/undo-parent`, { method: 'POST', body: JSON.stringify({ kind: 'created', after: created }) });
      await loadCanvas(targetCanvasId); return;
    }
    const latest = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId), { cache: 'no-store' });
    const current = latest.blocks.find(block => block.id === created.id);
    if (!current) throw new Error('This document is already gone.');
    if (agentCreatedDocumentChanged(current, created, latest)) throw new Error('This document changed after the agent created it. Review it before deleting.');
    await api(`/canvases/${encodeURIComponent(targetCanvasId)}/blocks/${encodeURIComponent(created.id)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedDocumentState: documentReviewState(current),
        expectedSavedCrossLinks: JSON.stringify(created.crossLinks ?? []), requireUnreferenced: true }),
    });
    await loadCanvas(targetCanvasId);
  }

  async function undoAgentEditedBlock(targetCanvasId: string, edit: CanvasEdit): Promise<void> {
    if (edit.after.incarnation && edit.after.sourceGeneration) {
      await api(`/canvases/${encodeURIComponent(targetCanvasId)}/jev/undo-parent`, { method: 'POST', body: JSON.stringify({ kind: 'edited', before: edit.before, after: edit.after }) });
      await loadCanvas(targetCanvasId); return;
    }
    const latest = await api<CanvasDocument>('/canvases/' + encodeURIComponent(targetCanvasId), { cache: 'no-store' });
    const current = latest.blocks.find(block => block.id === edit.after.id);
    requireUnchangedAgentEdit(current, edit);
    const before = edit.before;
    await api(`/canvases/${encodeURIComponent(targetCanvasId)}/blocks/${encodeURIComponent(before.id)}`, {
      method: 'PUT', body: JSON.stringify({ ...restoreAgentEditPayload(before, current.contentHash), expectedDocumentState: documentReviewState(current),
        expectedSavedCrossLinks: JSON.stringify(edit.after.crossLinks ?? []) }),
    });
    await loadCanvas(targetCanvasId);
  }

  function summarizeSelection(blocks: CanvasBlock[]) {
    setShowChat(true);
    setAssistantView('chat');
    const names = blocks.map(block => `${block.title} (${block.id})`).join(', ');
    const text = `Summarize these selected canvas documents together: ${names}. Read each document, identify shared themes, differences, and source links. Do not edit the canvas.`;
    setChatPromptRequest(current => ({ text, sequence: (current?.sequence ?? 0) + 1 }));
  }

  return { refreshCanvasAfterChat, undoAgentCreatedBlock, undoAgentEditedBlock, summarizeSelection };
}

export type ChatCanvasActions = ReturnType<typeof useChatCanvasActions>;
