import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import type { ResearchCanvasEdits } from './research-edits';
import type { CanvasDocument } from '../shared/types';
import './saved-investigations.css';

export type InvestigationMessage = { role: 'user' | 'assistant'; content: string };
export type InvestigationSourceRef = { canvasId: string; blockId: string; contentHash?: string; revisionId?: string; excerpt?: string };
export type InvestigationSourceChange = { canvasId: string; blockId: string; oldHash?: string; currentHash?: string };
export type InvestigationProposalRef = { kind: 'chat' | 'jev'; id: string; status?: string };
export type InvestigationResearchSnapshot = { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout };
export type InvestigationRecord = { id: string; workspaceId: string; canvasId?: string; title: string; visibility: 'private' | 'shared';
  question?: string; messages: InvestigationMessage[]; sourceRefs: InvestigationSourceRef[]; proposalRefs: InvestigationProposalRef[];
  researchSnapshot?: InvestigationResearchSnapshot;
  revision: number; createdAt: string; updatedAt: string };
type InvestigationSummary = Pick<InvestigationRecord, 'id' | 'workspaceId' | 'canvasId' | 'title' | 'visibility' | 'question' | 'revision' | 'createdAt' | 'updatedAt'>
  & { messageCount: number; sourceCount: number; proposalCount: number };
type SavedResult = { investigation: InvestigationRecord; accessKey?: string };
export type SavedInvestigationsProps = { workspaceId: string; canvasId: string; messages: InvestigationMessage[];
  sourceRefs: InvestigationSourceRef[]; proposalRefs: InvestigationProposalRef[]; researchSnapshot?: InvestigationResearchSnapshot;
  onOpen: (record: InvestigationRecord) => void;
  onSaved?: (record: InvestigationRecord) => void;
  onClearSelection?: () => void;
  openRequest?: { id: string; sequence: number };
  onOpenSource?: (ref: InvestigationSourceRef) => void;
  onOpenProposal?: (ref: InvestigationProposalRef, record: InvestigationRecord) => Promise<void>;
  onRecheck?: (record: InvestigationRecord, changedSources: InvestigationSourceChange[]) => void };

const keyStore = 'symbiknow.investigation-keys.v1';
type SourceCheck = InvestigationSourceChange & { title: string; savedExcerpt?: string; currentExcerpt?: string;
  state: 'current' | 'changed' | 'missing' | 'unknown' };
function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : 'Request failed. Try again.'; }

function savedKeys(): Record<string, string> {
  const raw = window.localStorage.getItem(keyStore);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Private access keys in this browser are invalid.');
  return Object.fromEntries(Object.entries(value).filter(([id, key]) => /^[a-z0-9-]{1,64}$/.test(id) && typeof key === 'string'));
}

function storeKey(id: string, key?: string): void {
  const keys = savedKeys();
  if (key) keys[id] = key;
  else delete keys[id];
  window.localStorage.setItem(keyStore, JSON.stringify(keys));
}

export function SavedInvestigations({ workspaceId, canvasId, messages, sourceRefs, proposalRefs, researchSnapshot, onOpen,
  onSaved, onClearSelection, openRequest, onOpenSource, onOpenProposal, onRecheck }: SavedInvestigationsProps) {
  const [items, setItems] = useState<InvestigationSummary[]>([]);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [selected, setSelected] = useState<InvestigationRecord | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [unreadableKey, setUnreadableKey] = useState('');
  const [sourceChecks, setSourceChecks] = useState<SourceCheck[] | null>(null);
  const [sourceCheckError, setSourceCheckError] = useState('');
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError('');
    try {
      const keys = savedKeys();
      const response = await api<{ investigations: InvestigationSummary[] }>('/investigations/list', {
        method: 'POST', body: JSON.stringify({ workspaceId, privateKeys: Object.values(keys).slice(0, 200) }),
      });
      if (id === requestId.current) setItems(response.investigations);
    } catch (reason) { if (id === requestId.current) setError('Could not list investigations: ' + errorText(reason)); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [workspaceId]);

  useEffect(() => {
    setSelected(null); setTitle(''); setItems([]); setError(''); setReceipt('');
  }, [workspaceId]);

  useEffect(() => {
    if (!selected?.sourceRefs.length) { setSourceChecks([]); setSourceCheckError(''); return; }
    let active = true;
    setSourceChecks(null); setSourceCheckError('');
    const check = async () => {
      try {
        const documents = await Promise.all([...new Set(selected.sourceRefs.map(ref => ref.canvasId))]
          .map(id => api<CanvasDocument>('/canvases/' + encodeURIComponent(id))));
        if (!active) return;
        if (!documents.every(document => document && typeof document.id === 'string' && Array.isArray(document.blocks))) {
          throw new Error('Current canvas data is unavailable.');
        }
        const byCanvas = new Map(documents.map(document => [document.id, document]));
        setSourceChecks(selected.sourceRefs.map(ref => {
          const block = byCanvas.get(ref.canvasId)?.blocks.find(item => item.id === ref.blockId);
          const currentHash = block?.contentHash;
          return { canvasId: ref.canvasId, blockId: ref.blockId, oldHash: ref.contentHash, currentHash,
            title: block?.title ?? ref.blockId, savedExcerpt: ref.excerpt,
            currentExcerpt: block?.content.slice(0, 480),
            state: !block ? 'missing' : !ref.contentHash || !currentHash ? 'unknown'
              : ref.contentHash === currentHash ? 'current' : 'changed' };
        }));
      } catch (reason) { if (active) setSourceCheckError(errorText(reason)); }
    };
    void check();
    return () => { active = false; };
  }, [selected?.id, selected?.revision]);

  useEffect(() => {
    if (isOpen) void refresh();
    return () => { ++requestId.current; };
  }, [isOpen, refresh]);

  function newInvestigation() { setSelected(null); onClearSelection?.(); setTitle(''); setVisibility('private'); setReceipt(''); setError(''); }

  async function open(item: Pick<InvestigationSummary, 'id'>) {
    setBusy(true); setError(''); setReceipt('');
    try {
      const key = savedKeys()[item.id];
      const record = await api<InvestigationRecord>('/investigations/' + encodeURIComponent(item.id),
        key ? { headers: { 'x-investigation-key': key } } : {});
      setSelected(record); setTitle(record.title); setVisibility(record.visibility);
      onOpen(record);
      setReceipt('Opened ' + record.title + '. Save changes to update this investigation.');
    } catch (reason) { setError('Could not open investigation: ' + errorText(reason) + ' Refresh the list or check this browser’s private access key.'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!openRequest) return;
    setIsOpen(true);
    void open(openRequest);
  }, [openRequest?.sequence]);

  async function openProposal(proposal: InvestigationProposalRef, record: InvestigationRecord) {
    if (!onOpenProposal) return;
    setBusy(true); setError('');
    try { await onOpenProposal(proposal, record); setReceipt('Opened proposal ' + proposal.id + ' in Chat.'); }
    catch (reason) { setError('Could not open proposal: ' + errorText(reason) + ' Ask Chat to prepare a fresh proposal if it expired.'); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    if (messages.length > 100 || messages.some(message => !message.content.trim() || message.content.length > 20_000)
      || sourceRefs.length > 100 || proposalRefs.length > 100) {
      setError('This investigation exceeds the save limit: up to 100 messages and references, with each message under 20,000 characters.');
      return;
    }
    if (researchSnapshot && new TextEncoder().encode(JSON.stringify(researchSnapshot)).length > 1_000_000) {
      setError('The research canvas exceeds the 1 MB investigation limit. Save a smaller research session or export the canvas first.');
      return;
    }
    setBusy(true); setError(''); setReceipt(''); setUnreadableKey('');
    const data = { canvasId, title: title.trim(), visibility, question: messages.find(message => message.role === 'user')?.content.slice(0, 2_000),
      messages, sourceRefs, proposalRefs, ...(researchSnapshot ? { researchSnapshot } : {}) };
    try {
      const oldKey = selected ? savedKeys()[selected.id] : undefined;
      const result = selected
        ? await api<SavedResult>('/investigations/' + encodeURIComponent(selected.id), { method: 'PATCH',
          headers: oldKey ? { 'x-investigation-key': oldKey } : {}, body: JSON.stringify({ ...data, expectedRevision: selected.revision }) })
        : await api<SavedResult>('/investigations', { method: 'POST', body: JSON.stringify({ workspaceId, ...data }) });
      setSelected(result.investigation);
      onSaved?.(result.investigation);
      try { if (result.accessKey || visibility === 'shared') storeKey(result.investigation.id, result.accessKey); }
      catch { if (result.accessKey) setUnreadableKey(result.accessKey); }
      setReceipt('Saved ' + result.investigation.title + ' (' + visibility + ').');
      await refresh();
    } catch (reason) { setError('Could not save investigation: ' + errorText(reason) + ' Refresh and reopen it before retrying.'); }
    finally { setBusy(false); }
  }

  const changedSources = sourceChecks?.filter(check => check.state === 'changed' || check.state === 'missing') ?? [];
  const uncheckedSources = sourceChecks?.filter(check => check.state === 'unknown') ?? [];

  return <section className="saved-investigations" aria-label="Saved investigations">
    <details open={isOpen} onToggle={event => setIsOpen(event.currentTarget.open)}><summary>Saved investigations <span>{items.length}</span></summary>
      {isOpen && <div className="saved-investigations__body">
        <p className="saved-investigations__access">Private access is saved in this browser’s local storage. Other browsers cannot reopen a private investigation without its access key. Shared investigations are visible to this workspace.</p>
        <form onSubmit={event => void save(event)}>
          <label>Name<input aria-label="Investigation name" value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="Name this investigation" required/></label>
          <label>Access<select aria-label="Investigation access" value={visibility} onChange={event => setVisibility(event.target.value as 'private' | 'shared')}><option value="private">Private to this browser</option><option value="shared">Shared with workspace</option></select></label>
          <div className="saved-investigations__actions"><button type="submit" disabled={busy || !title.trim()}>{busy ? 'Saving…' : selected ? 'Save changes' : 'Save investigation'}</button>
            {selected && <button type="button" onClick={newInvestigation} disabled={busy}>Save as new</button>}</div>
        </form>
        {unreadableKey && <p className="saved-investigations__key" role="alert">Saved privately, but this browser could not store its access key. Copy this key now: <code>{unreadableKey}</code></p>}
        {receipt && <p role="status" className="saved-investigations__receipt">{receipt}</p>}
        {error && <div role="alert" className="saved-investigations__error"><p>{error}</p><button type="button" onClick={() => void refresh()}>Retry list</button></div>}
        <div className="saved-investigations__list-heading"><strong>In this workspace</strong><button type="button" onClick={() => void refresh()} disabled={loading || busy}>Refresh</button></div>
        {loading ? <p role="status">Loading investigations…</p> : items.length === 0 ? error ? null : <p>No saved investigations yet.</p>
          : <ul>{items.map(item => <li key={item.id}><div><strong>{item.title}</strong><small>{item.visibility === 'private' ? 'Private in this browser' : 'Shared'} · {item.messageCount} messages · {new Date(item.updatedAt).toLocaleDateString()}</small></div>
            <button type="button" onClick={() => void open(item)} disabled={busy}>Open</button></li>)}</ul>}
        {selected && <div className="saved-investigations__detail" aria-label="Opened investigation details">
          <strong>{selected.title}</strong>
          <p>{selected.sourceRefs.length} source{selected.sourceRefs.length === 1 ? '' : 's'} · {selected.proposalRefs.length} proposal{selected.proposalRefs.length === 1 ? '' : 's'} · {selected.researchSnapshot?.turns.length ?? 0} research turns · revision {selected.revision}</p>
          {sourceChecks === null && <p role="status">Checking saved sources against current documents…</p>}
          {sourceCheckError && <p role="status">Source freshness could not be checked: {sourceCheckError}. Reopen this investigation to retry.</p>}
          {uncheckedSources.length > 0 && <p role="status">{uncheckedSources.length} source{uncheckedSources.length === 1 ? '' : 's'} cannot be compared because a saved or current hash is unavailable.</p>}
          {changedSources.length > 0 && <div className="saved-investigations__stale" role="status">
            <strong>{changedSources.length} source{changedSources.length === 1 ? '' : 's'} changed since this investigation was saved</strong>
            <p>Earlier answers may need updating. Compare the saved context with the current document, then recheck the answer.</p>
            {onRecheck && <button type="button" onClick={() => onRecheck(selected, changedSources)}>Recheck answer against current sources</button>}
            <details><summary>Compare source context</summary><ul>{changedSources.map(check => <li key={`${check.canvasId}:${check.blockId}`}>
              <strong>{check.title}</strong><small>Saved hash {check.oldHash ?? 'unavailable'} · Current hash {check.currentHash ?? 'document missing'}</small>
              <div><section><b>Saved context</b><p>{check.savedExcerpt ?? 'No saved passage available.'}</p></section>
                <section><b>Current document beginning</b><p>{check.currentExcerpt ?? 'Document no longer available.'}</p></section></div>
            </li>)}</ul></details>
          </div>}
          {selected.sourceRefs.length > 0 && <><h4>Sources</h4><ul>{selected.sourceRefs.map((source, index) => <li key={`${source.canvasId}:${source.blockId}:${index}`}>
            {onOpenSource ? <button type="button" onClick={() => onOpenSource(source)}>Open {source.canvasId} / {source.blockId}</button>
              : <span>{source.canvasId} / {source.blockId}</span>}
            {(source.revisionId || source.contentHash) && <small>{source.revisionId ? 'Revision ' + source.revisionId : 'Hash ' + source.contentHash}</small>}
          </li>)}</ul></>}
          {selected.proposalRefs.length > 0 && <><h4>Proposals</h4><ul>{selected.proposalRefs.map((proposal, index) => <li key={`${proposal.kind}:${proposal.id}:${index}`}>
            <span>{proposal.kind} · {proposal.id}</span><small>{proposal.status ?? 'Status unknown'}</small>
            {proposal.kind === 'chat' && onOpenProposal && <button type="button" disabled={busy} onClick={() => void openProposal(proposal, selected)}>Review proposal in Chat</button>}
          </li>)}</ul></>}
        </div>}
      </div>}
    </details>
  </section>;
}
