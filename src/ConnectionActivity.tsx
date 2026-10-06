import { useEffect, useState } from 'react';
import type { WorkspaceSummary } from '../shared/types';
import { api } from './api';
import { effectiveTokenScope } from './connection-scope';
import type { McpInfo, McpActivityEntry, OpenActivityHistory } from './connection-types';

export function ConnectionActivity({ info, infoError, onRetryInfo, onOpenHistory, workspaces }: {
  info: McpInfo | null; infoError: string; onRetryInfo: () => void; onOpenHistory?: OpenActivityHistory;
  workspaces: WorkspaceSummary[] | null;
}) {
  const [entries, setEntries] = useState<McpActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<{ entries: McpActivityEntry[] }>('/mcp/activity')
      .then(result => {
        if (!Array.isArray(result?.entries)) throw new Error('Activity response was incomplete. Retry in a moment.');
        if (active) setEntries(result.entries);
      })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Could not load agent activity.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  return <section className="settings-page__section settings-activity" id="settings-activity" data-section="activity" aria-labelledby="settings-activity-title">
    <div className="settings-page__section-heading"><h3 id="settings-activity-title">Agent activity</h3>
      <p>Recent calls made with workspace access tokens, including reads and failed attempts. This activity feed is a recent view, not a complete audit log.</p></div>
    <ConnectionHealthView info={info} error={infoError} onRetry={onRetryInfo}/>
    <div className="activity-list-heading"><strong>Recent tool calls</strong>
      <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh activity'}</button></div>
    <ActivityResults entries={entries} loading={loading} error={error} onRetry={() => setAttempt(value => value + 1)} onOpenHistory={onOpenHistory} workspaces={workspaces}/>
    <p className="activity-caveat">A token’s last-used time shows its most recent observed use. It does not summarize every call; use the entries above for recent reads, changes, and failures.</p>
  </section>;
}

function ConnectionHealthView({ info, error, onRetry }: { info: McpInfo | null; error: string; onRetry: () => void }) {
  return <div className="activity-health" aria-label="MCP connection health">
    <div><strong>Connection health</strong>{error ? <span className="activity-health__error">Unavailable</span>
      : info ? <span className="activity-health__ok">Status available</span> : <span>Checking…</span>}</div>
    {info ? <HealthDetails info={info}/> : error && <p role="alert">{error}</p>}
    {error && <button type="button" className="secondary-button" onClick={onRetry}>Retry connection check</button>}
  </div>;
}
function HealthDetails({ info }: { info: McpInfo }) {
  return <p>{info.publicUrlConfigured ? 'Public endpoint configured.' : 'Public endpoint is not configured; remote clients may not be able to connect.'}
    {' '}{info.accessProtected ? 'Workspace access protection is enabled.' : 'Workspace access protection is not enabled.'}
    {' '}{info.activeSessions} active session{info.activeSessions === 1 ? '' : 's'} reported.</p>;
}
function ActivityResults({ entries, loading, error, onRetry, onOpenHistory, workspaces }: { entries: McpActivityEntry[]; loading: boolean; error: string; onRetry: () => void; onOpenHistory?: OpenActivityHistory; workspaces: WorkspaceSummary[] | null }) {
  if (loading) return <p className="activity-state" role="status">Loading recent agent activity…</p>;
  if (error) return <div className="activity-error" role="alert"><span>{error}</span><button type="button" className="secondary-button" onClick={onRetry}>Retry</button></div>;
  if (!entries.length) return <p className="activity-state">No recent tool calls are recorded. Agents can connect from the client instructions above.</p>;
  return <ol className="activity-list">{entries.map(entry => <ActivityEntry key={entry.id} entry={entry} workspaces={workspaces} onOpenHistory={onOpenHistory}/>)}</ol>;
}
function ActivityEntry({ entry, workspaces, onOpenHistory }: { entry: McpActivityEntry; workspaces: WorkspaceSummary[] | null; onOpenHistory?: OpenActivityHistory }) {
  return <li>
    <div className="activity-entry__top"><strong>{entry.tool}</strong><span className={`activity-outcome activity-outcome--${entry.outcome}`}>{entry.outcome}</span></div>
    <p>{entry.tokenName} · {entry.access} access · {new Date(entry.startedAt).toLocaleString()}
      {entry.endedAt ? ` · finished ${new Date(entry.endedAt).toLocaleTimeString()}` : ''}</p>
    <p className="activity-entry__scope"><strong>Effective scope:</strong> {effectiveTokenScope({ access: entry.access,
      allowedCanvasIds: entry.allowedCanvasIds, tools: entry.tools }, workspaces)}</p>
    {entry.error && <p className="activity-entry__error">{entry.error}</p>}
    <ActivityReferences entry={entry}/><ActivityRevision entry={entry} onOpenHistory={onOpenHistory}/>
  </li>;
}
function ActivityReferences({ entry }: { entry: McpActivityEntry }) {
  return <>{(entry.canvasIds ?? []).length > 0 && <p><strong>Canvas:</strong> {entry.canvasIds.join(', ')}</p>}
    {(entry.documentIds ?? []).length > 0 && <p><strong>Documents:</strong> {entry.documentIds.join(', ')}</p>}</>;
}
function ActivityRevision({ entry, onOpenHistory }: { entry: McpActivityEntry; onOpenHistory?: OpenActivityHistory }) {
  if (!entry.revision) return null;
  return <p><strong>Revision:</strong> <code>{entry.revision}</code>{onOpenHistory && entry.canvasIds[0] && entry.documentIds[0] && <>{' '}<button type="button" className="activity-history-link"
    onClick={() => onOpenHistory(entry.canvasIds[0], entry.documentIds[0], entry.revision!)}>Inspect in document History</button></>}</p>;
}
