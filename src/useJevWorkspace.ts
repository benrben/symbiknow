import { useCallback, useEffect, useRef, useState } from 'react';
import type { JevMutation, JevReceipt, JevSettings } from '../shared/jev-types';
import type { SymbiDocumentProgress } from '../shared/symbi-contract';
import type { AvatarState } from './avatar-types';
import { api } from './api';
import type { JevViewState } from './jev-client-types';
import { changedReceipts, jevAvatarState, operationNotice, optimisticSettings, ownerWorkspaceView, skipWorkspaceRefresh, workspaceFailure } from './jev-workspace-status';
export type { JevViewState } from './jev-client-types';

function canvasTargets(mutation: JevMutation): string[] {
  if (mutation.kind === 'vocabulary') return mutation.term.members.map(member => member.canvasId);
  if (mutation.kind === 'move') return [mutation.canvasId, mutation.targetCanvasId];
  if (mutation.kind === 'document' || mutation.kind === 'content') return [mutation.canvasId];
  return [];
}

function canvasReceipts(receipts: JevReceipt[], canvasId?: string): string {
  return receipts.filter(receipt => [...canvasTargets(receipt.before), ...canvasTargets(receipt.after)]
    .some(id => !canvasId || id === canvasId)).map(receipt => `${receipt.id}:${receipt.state}`).join('|');
}

function viewVersion(state: JevViewState, details: boolean): string {
  return JSON.stringify([details, state.revision, state.hasApiKey, state.canApprove, state.canConfigure]);
}

function currentRead(workspaceId: string, currentWorkspace: string, requestGeneration: number, generation: number): boolean {
  return workspaceId === currentWorkspace && requestGeneration === generation;
}

function receiptChanged(previous: { canvasId?: string; signature: string } | undefined, canvasId: string | undefined, signature: string): boolean {
  return changedReceipts(previous?.canvasId === canvasId ? previous?.signature : undefined, signature);
}

async function reloadAfterOperation(operation: string, onChanged?: () => Promise<unknown>): Promise<void> {
  if (operation === 'reset') await onChanged?.();
}

async function readWorkspaceView(base: string, details: boolean, force: boolean, previous: JevViewState | null): Promise<JevViewState> {
  if (!details) return ownerWorkspaceView(await api<JevViewState>(base + '/state?summary=1'));
  if (force || !previous) return ownerWorkspaceView(await api<JevViewState>(base + '/state'));
  const summary = ownerWorkspaceView(await api<JevViewState>(base + '/state?summary=1'));
  if (viewVersion(summary, true) === viewVersion(previous, true)) return previous;
  return ownerWorkspaceView(await api<JevViewState>(base + '/state'));
}

export function useJevWorkspace(workspaceId: string, active = true, onChanged?: () => Promise<unknown>, canvasId?: string) {
  const [state, setState] = useState<JevViewState | null>(null);
  const [progress, setProgress] = useState<SymbiDocumentProgress[]>([]);
  const [progressError, setProgressError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState<AvatarState>(() => jevAvatarState(null, ''));
  const changing = useRef(false);
  const currentWorkspace = useRef(workspaceId);
  const lastReceiptState = useRef<{ canvasId?: string; signature: string } | undefined>(undefined);
  const onCanvasChanged = useRef(onChanged);
  const currentCanvas = useRef(canvasId);
  const generation = useRef(0);
  const lastVersion = useRef<string | undefined>(undefined);
  const progressRequest = useRef(0);
  const lastFullView = useRef<JevViewState | null>(null);
  const detailsOpen = useRef(false);
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  onCanvasChanged.current = onChanged;
  currentCanvas.current = canvasId;
  currentWorkspace.current = workspaceId;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/jev`;
  const accept = useCallback(async (next: JevViewState, force: boolean, details: boolean) => {
    const receiptState = canvasReceipts(next.receipts, currentCanvas.current);
    const changed = receiptChanged(lastReceiptState.current, currentCanvas.current, receiptState);
    lastReceiptState.current = { canvasId: currentCanvas.current, signature: receiptState };
    const version = viewVersion(next, details);
    if (details) lastFullView.current = next;
    if (force || version !== lastVersion.current) setState(next);
    lastVersion.current = version; setAvatar(jevAvatarState(next, '')); setError('');
    if (changed && !force) await onCanvasChanged.current?.();
  }, []);
  const refresh = useCallback((force = false): Promise<void> => {
    if (skipWorkspaceRefresh(workspaceId, currentWorkspace.current, changing.current, force)) return Promise.resolve();
    if (force) generation.current += 1;
    const requestGeneration = generation.current;
    const details = detailsOpen.current;
    const key = `${workspaceId}:${requestGeneration}:${details}`;
    if (inFlight.current?.key === key) return inFlight.current.promise;
    const request = { key, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const next = await readWorkspaceView(base, details, force, lastFullView.current);
        if (!currentRead(workspaceId, currentWorkspace.current, requestGeneration, generation.current)) return;
        await accept(next, force, details);
        const requestedCanvas = currentCanvas.current;
        if (requestedCanvas) {
          const requestNumber = ++progressRequest.current;
          void (async () => { try {
          const route = `${base}/progress?canvasId=${encodeURIComponent(requestedCanvas)}`;
          const result = await api<{ version: 1; documents: SymbiDocumentProgress[] }>(route);
          if (currentRead(workspaceId, currentWorkspace.current, requestGeneration, generation.current)
            && requestedCanvas === currentCanvas.current && requestNumber === progressRequest.current) {
            setProgress(result.documents);
            setProgressError('');
          }
        } catch (failure) {
          if (currentRead(workspaceId, currentWorkspace.current, requestGeneration, generation.current)
            && requestNumber === progressRequest.current)
            setProgressError(workspaceFailure(failure, 'Document progress could not load'));
          } })();
        }
      }
      catch (failure) {
        if (currentRead(workspaceId, currentWorkspace.current, requestGeneration, generation.current)) setError(workspaceFailure(failure, 'Symbi Reflex could not load this workspace'));
      }
      finally { if (inFlight.current === request) inFlight.current = null; }
    })();
    inFlight.current = request;
    return request.promise;
  }, [accept, base, workspaceId]);
  const setDetailsOpen = useCallback((open: boolean) => {
    if (detailsOpen.current === open) return;
    detailsOpen.current = open; generation.current += 1;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setState(null); setProgress([]); setProgressError(''); setAvatar(jevAvatarState(null, ''));
    generation.current += 1; progressRequest.current += 1;
    lastVersion.current = undefined;
    lastFullView.current = null;
    lastReceiptState.current = undefined;
    if (!active || !workspaceId) return;
    void refresh();
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const timer = setInterval(poll, 1500);
    document.addEventListener('visibilitychange', poll);
    return () => { generation.current += 1; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [active, workspaceId, refresh]);

  async function send(operation: string, body: unknown = {}, method = 'POST') {
    setBusy(true); setError(''); setNotice('');
    changing.current = true;
    generation.current += 1;
    lastVersion.current = undefined;
    if (operation === 'settings' && method === 'PUT') {
      const patch = body as Partial<JevSettings>;
      setState(current => optimisticSettings(current, patch));
    }
    try {
      const result = await api(base + '/' + operation, { method, body: JSON.stringify(body) });
      await refresh(true);
      await reloadAfterOperation(operation, onCanvasChanged.current);
      setNotice(operationNotice(operation));
      return result;
    } catch (failure) { await refresh(true); setError(workspaceFailure(failure, 'The change could not be saved')); return undefined; }
    finally { changing.current = false; setBusy(false); }
  }

  return { state, progress, progressError, error, notice, busy, refresh, send, setDetailsOpen,
    avatar: error ? jevAvatarState(state, error) : avatar };
}

export type JevWorkspaceModel = ReturnType<typeof useJevWorkspace>;
