import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import type { CanvasBlock } from '../shared/types';

type Commit = { id: string; parents: string[]; message: string; createdAt: string; author?: string };
type VersionStatus = { current: string; branches: string[]; commits: Commit[] };

export function VersionPanel({ canvasId, block, onChanged }: { canvasId: string; block: CanvasBlock; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<VersionStatus | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/canvases/${encodeURIComponent(canvasId)}/blocks/${encodeURIComponent(block.id)}/versions`;

  useEffect(() => { let active = true;
    api<VersionStatus>(base).then(value => { if (active) setStatus(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [base]);

  async function run(route: string, payload: Record<string, string>, refreshCanvas = false) {
    setBusy(true); setError('');
    try {
      const next = await api<VersionStatus>(`${base}/${route}`, { method: 'POST', body: JSON.stringify(payload) });
      setStatus(next);
      if (refreshCanvas) await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not change version history.'); }
    finally { setBusy(false); }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void run('branches', { name: name.trim() });
    setName('');
  }

  const otherBranches = status?.branches.filter(branch => branch !== status.current) ?? [];
  const target = selected && otherBranches.includes(selected) ? selected : otherBranches[0];
  return <div className="version-panel">
    <p className="version-panel__intro"><strong>{block.title}</strong> · {block.file}<br/>Every saved source change creates a revision for this file. Branching or merging it leaves other documents and canvas positions untouched.</p>
    {error && <p className="version-panel__error" role="alert">{error}</p>}
    <section className="version-panel__section" aria-label="Branches">
      <div className="version-panel__section-title"><h3>Branches</h3><span className="version-panel__current">Current: {status?.current ?? 'Loading…'}</span></div>
      <div className="version-panel__branch-list">{status?.branches.map(branch => <button key={branch} disabled={busy || branch === status.current} className={branch === status.current ? 'is-current' : ''} onClick={() => void run('switch', { name: branch }, true)} title={branch === status.current ? 'Current branch' : `Switch to ${branch}`}><span>⑂</span>{branch}{branch === status.current && <small>Active</small>}</button>)}</div>
      <form className="version-panel__create" onSubmit={create}><input aria-label="New branch name" placeholder="New branch name" value={name} onChange={event => setName(event.target.value)} disabled={busy}/><button className="secondary-button" disabled={busy || !name.trim()}>Create branch</button></form>
      {otherBranches.length > 0 && <div className="version-panel__merge"><select aria-label="Branch to merge" value={target} onChange={event => setSelected(event.target.value)} disabled={busy}>{otherBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select><button className="secondary-button" disabled={busy} onClick={() => void run('merge', { name: target }, true)}>Merge into {status?.current}</button></div>}
    </section>
    <section className="version-panel__section" aria-label="Revision history">
      <div className="version-panel__section-title"><h3>Recent revisions</h3><small>{status?.commits.length ?? 0} shown</small></div>
      <ol className="version-panel__commits">{status?.commits.map(commit => <li key={commit.id}><div><strong>{commit.message}</strong><small>{commit.author && <span className="version-panel__author">{commit.author}</span>}{commit.id.slice(0, 8)} · {new Date(commit.createdAt).toLocaleString()}</small></div><button disabled={busy} onClick={() => void run('restore', { revision: commit.id }, true)}>Restore</button></li>)}</ol>
    </section>
  </div>;
}
