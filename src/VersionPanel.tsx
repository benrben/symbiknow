import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import type { CanvasBlock } from '../shared/types';

type Commit = { id: string; parents: string[]; message: string; createdAt: string; author?: string };
type VersionStatus = { current: string; branches: string[]; commits: Commit[] };
type Action = { kind: 'switch' | 'merge' | 'restore'; value: string; label: string };
type Preview = { before: string; after: string; scope: string; revision?: Commit | string };
const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'Could not change history. Try again.';

export function VersionPanel({ canvasId, block, initialRevision, onChanged }: { canvasId: string; block: CanvasBlock; initialRevision?: string; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<VersionStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [undoRevision, setUndoRevision] = useState('');
  const requestId = useRef(0);
  const linkedRevision = useRef(initialRevision);
  const base = '/canvases/' + encodeURIComponent(canvasId) + '/blocks/' + encodeURIComponent(block.id) + '/versions';

  async function refreshStatus() {
    setLoadingStatus(true);
    try { setStatus(await api<VersionStatus>(base)); setError(''); }
    catch (reason) { setError('Could not load saved history: ' + failureMessage(reason)); }
    finally { setLoadingStatus(false); }
  }

  useEffect(() => { let active = true;
    setLoadingStatus(true);
    api<VersionStatus>(base).then(value => { if (active) { setStatus(value); setError(''); } })
      .catch(reason => { if (active) setError('Could not load saved history: ' + failureMessage(reason)); })
      .finally(() => { if (active) setLoadingStatus(false); });
    return () => { active = false; };
  }, [base]);

  async function choose(next: Action) {
    const id = ++requestId.current;
    setAction(next); setPreview(null); setError(''); setReceipt(''); setUndoRevision(''); setLoadingPreview(true);
    const parameter = next.kind === 'restore' ? 'revision' : 'name';
    try {
      const value = await api<Preview>(base + '/preview?kind=' + next.kind + '&' + parameter + '=' + encodeURIComponent(next.value));
      if (requestId.current === id) setPreview(value);
    } catch (reason) { if (requestId.current === id) setError('Preview failed: ' + failureMessage(reason) + ' Saved content is unchanged. Retry the preview before applying.'); }
    finally { if (requestId.current === id) setLoadingPreview(false); }
  }

  useEffect(() => {
    const revision = linkedRevision.current;
    if (!revision || !status) return;
    linkedRevision.current = undefined;
    void choose({ kind: 'restore', value: revision, label: 'Inspect linked revision ' + revision.slice(0, 12) });
  }, [status]);

  async function apply() {
    if (!action || !preview || busy) return;
    setBusy(true); setError('');
    const previousRevision = status?.commits[0]?.id ?? '';
    try {
      const payload = action.kind === 'restore' ? { revision: action.value } : { name: action.value };
      const next = await api<VersionStatus>(base + '/' + action.kind, { method: 'POST', body: JSON.stringify(payload) });
      setStatus(next);
      setReceipt(action.label + ' completed. Document content is saved on ' + next.current + ' at revision ' + (next.commits[0]?.id.slice(0, 12) ?? 'current') + '. To undo, preview the previous saved revision and restore it as a new revision.');
      setUndoRevision(previousRevision);
      setAction(null); setPreview(null);
      try { await onChanged(); }
      catch (reason) { setError('Document content was saved, but the canvas did not refresh: ' + failureMessage(reason) + ' Reopen this canvas to see the saved version. Do not apply this change again.'); }
    } catch (reason) { setError('Could not confirm whether document content was saved: ' + failureMessage(reason) + ' Reload saved history and inspect the current revision before retrying.'); setPreview(null); }
    finally { setBusy(false); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError('');
    try {
      const next = await api<VersionStatus>(base + '/branches', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setStatus(next); setReceipt('Branch ' + name.trim() + ' created. Document content is unchanged; current branch: ' + next.current + '.'); setName('');
    } catch (reason) { setError(failureMessage(reason)); }
    finally { setBusy(false); }
  }

  const otherBranches = status?.branches.filter(branch => branch !== status.current) ?? [];
  const target = selected && otherBranches.includes(selected) ? selected : otherBranches[0];
  const revision = typeof preview?.revision === 'string' ? status?.commits.find(commit => commit.id === preview.revision) : preview?.revision;
  return <div className="version-panel">
    <p className="version-panel__intro"><strong>{block.title}</strong> · {block.file}<br/>History affects this document's content only. Other documents and canvas positions stay in place.</p>
    {error && <div className="version-panel__error" role="alert"><p>{error}</p>{action && !preview && !loadingPreview && <button type="button" className="secondary-button" onClick={() => void choose(action)}>Retry read-only preview</button>}<button type="button" className="secondary-button" disabled={loadingStatus} onClick={() => void refreshStatus()}>Reload saved history</button></div>}
    {receipt && <div className="version-panel__receipt" role="status"><p>{receipt}</p>{undoRevision && <button type="button" className="secondary-button" onClick={() => void choose({ kind: 'restore', value: undoRevision, label: 'Undo by restoring ' + undoRevision.slice(0, 12) })}>Preview undo</button>}</div>}
    <section className="version-panel__section" aria-label="Branches">
      <div className="version-panel__section-title"><h3>Branches</h3><span className="version-panel__current">Current saved branch: {status?.current ?? (loadingStatus ? 'Loading…' : 'Unavailable')}</span></div>
      <div className="version-panel__branch-list">{status?.branches.map(branch => <button key={branch} type="button" disabled={busy || branch === status.current} className={branch === status.current ? 'is-current' : ''} onClick={() => void choose({ kind: 'switch', value: branch, label: 'Switch to ' + branch })}><span>⑂</span>{branch}{branch === status.current && <small>Active</small>}</button>)}</div>
      <form className="version-panel__create" onSubmit={event => void create(event)}><input aria-label="New branch name" placeholder="New branch name" value={name} onChange={event => setName(event.target.value)} disabled={busy || !status}/><button className="secondary-button" disabled={busy || !status || !name.trim()}>Create branch</button></form>
      {otherBranches.length > 0 && <div className="version-panel__merge"><select aria-label="Branch to merge" value={target} onChange={event => setSelected(event.target.value)} disabled={busy}>{otherBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select><button type="button" className="secondary-button" disabled={busy} onClick={() => void choose({ kind: 'merge', value: target, label: 'Merge ' + target + ' into ' + status?.current })}>Preview merge into {status?.current}</button></div>}
    </section>
    <section className="version-panel__section" aria-label="Revision history">
      <div className="version-panel__section-title"><h3>Recent revisions</h3><small>{status?.commits.length ?? 0} shown</small></div>
      <ol className="version-panel__commits">{status?.commits.map(commit => <li key={commit.id} className={commit.id === initialRevision ? 'is-linked' : undefined}><div><strong>{commit.message}</strong><small>{commit.author && <span className="version-panel__author">{commit.author}</span>}{commit.id.slice(0, 12)} · {new Date(commit.createdAt).toLocaleString()}</small></div><button type="button" disabled={busy} onClick={() => void choose({ kind: 'restore', value: commit.id, label: 'Restore ' + commit.id.slice(0, 12) })}>Inspect revision</button></li>)}</ol>
    </section>
    {action && <section className="version-panel__preview" aria-label="Version preview">
      <h3>{action.label}</h3>
      {loadingPreview && <p role="status">Loading read-only preview. Saved content is unchanged…</p>}
      {preview && <><p><strong>Affected scope:</strong> {preview.scope}</p>
        {preview.revision && <p><strong>Revision:</strong> {typeof preview.revision === 'string' ? preview.revision.slice(0, 12) : preview.revision.id.slice(0, 12)} · {revision?.author ?? 'Unknown author'} · {revision ? new Date(revision.createdAt).toLocaleString() : 'Date unavailable'}</p>}
        <div className="version-panel__comparison"><div><h4>Before</h4><pre>{preview.before || '(empty document)'}</pre></div><div><h4>After</h4><pre>{preview.after || '(empty document)'}</pre></div></div>
        <p>This preview has not changed saved content. Review the complete content above before applying.{action.label.startsWith('Undo') ? ' Applying this undo saves a new revision.' : ''}</p></>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { ++requestId.current; setAction(null); setPreview(null); setLoadingPreview(false); }}>Cancel</button>
        <button type="button" className="primary-button" disabled={!preview || loadingPreview || busy} onClick={() => void apply()}>{busy ? 'Saving…' : 'Confirm ' + action.kind}</button></div>
    </section>}
  </div>;
}
