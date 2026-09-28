import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ChatSettings, McpTokenInfo, WorkspaceSummary } from '../shared/types';
import { api } from './api';

type McpInfo = { origin: string; endpoint: string; publicUrlConfigured: boolean; accessProtected: boolean; activeSessions: number };
type McpActivityEntry = { id: string; tokenId: string; tokenName: string; access: 'read' | 'propose' | 'write'; tool: string;
  allowedCanvasIds?: string[]; tools?: string[]; startedAt: string; endedAt: string; outcome: 'success' | 'error' | 'denied';
  error?: string; canvasIds: string[]; documentIds: string[]; revision?: string };
export type OpenActivityHistory = (canvasId: string, documentId: string, revision: string) => void;

const readMcpTools = ['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'download_file', 'list_tasks', 'analyze_canvas',
  'find_duplicates', 'connect_across_canvases', 'score_documents', 'list_versions'];
const writeMcpTools = ['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'create_doc', 'edit_doc', 'delete_doc', 'move_block',
  'link_blocks', 'unlink_blocks', 'upload_file', 'download_file', 'claim_doc', 'release_doc', 'list_tasks', 'create_task', 'update_task',
  'claim_task', 'comment_task', 'analyze_canvas', 'find_duplicates', 'merge_documents', 'undo_merge', 'connect_across_canvases',
  'score_documents', 'run_workspace_automation', 'list_versions', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision'];
const proposeMcpTools = [...readMcpTools, 'run_workspace_automation'];
function toolsForAccess(access: 'read' | 'propose' | 'write'): string[] {
  return access === 'read' ? readMcpTools : access === 'propose' ? proposeMcpTools : writeMcpTools;
}
function effectiveTokenScope(token: Pick<McpTokenInfo, 'access' | 'allowedCanvasIds' | 'tools'>, workspaces: WorkspaceSummary[] | null): string {
  const canvasIds = token.allowedCanvasIds;
  const canvases = Array.isArray(workspaces) ? workspaces.flatMap(workspace => workspace.canvases ?? []) : [];
  const canvasScope = !canvasIds ? 'All canvases' : `Canvases: ${canvasIds.map(id => canvases.find(canvas => canvas.id === id)?.name ?? id).join(', ')}`;
  const tools = token.tools;
  const access = token.access ?? 'write';
  const toolScope = !tools ? `All ${access} tools` : `Tools: ${tools.join(', ')}`;
  return `${canvasScope} · ${toolScope}`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="settings-copy" onClick={() => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }).catch(() => undefined);
  }}>{copied ? <Check size={12} aria-hidden="true"/> : <Copy size={12} aria-hidden="true"/>}{copied ? 'Copied' : label}</button>;
}

function Snippet({ title, note, code }: { title: string; note?: ReactNode; code: string }) {
  return <div className="connection-card">
    <div className="connection-card__top"><strong>{title}</strong><CopyButton text={code}/></div>
    {note && <p>{note}</p>}
    <pre className="connection-snippet">{code}</pre>
  </div>;
}

export function ConnectAgents({ settings, onSettings, onOpenHistory }: { settings: ChatSettings; onSettings: (settings: ChatSettings) => void; onOpenHistory?: OpenActivityHistory }) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');
  const [client, setClient] = useState('');
  const [access, setAccess] = useState<'read' | 'propose' | 'write'>('read');
  const [canvasScope, setCanvasScope] = useState<'all' | 'selected'>('all');
  const [selectedCanvasIds, setSelectedCanvasIds] = useState<string[]>([]);
  const [toolScope, setToolScope] = useState<'all' | 'selected'>('all');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const loadInfo = useCallback(async () => {
    setInfoError('');
    try { setInfo(await api<McpInfo>('/mcp/info')); }
    catch (failure) { setInfo(null); setInfoError(failure instanceof Error ? failure.message : 'Connection health is unavailable.'); }
  }, []);
  useEffect(() => { void loadInfo(); }, [loadInfo]);
  const loadWorkspaces = useCallback(async () => {
    setWorkspaceError('');
    try { setWorkspaces(await api<WorkspaceSummary[]>('/workspaces')); }
    catch (failure) { setWorkspaces(null); setWorkspaceError(failure instanceof Error ? failure.message : 'Could not load canvases.'); }
  }, []);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  const availableTools = toolsForAccess(access);
  const scopeInvalid = (canvasScope === 'selected' && (selectedCanvasIds.length === 0 || selectedCanvasIds.length > 100))
    || (toolScope === 'selected' && selectedTools.length === 0);
  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(endpoint);
  const envToken = '${SYMBIKNOW_MCP_TOKEN}';

  async function createToken() {
    if (!name.trim()) return;
    setError('');
    try {
      const result = await api<{ token: string; settings: ChatSettings }>('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim(), access,
        ...(canvasScope === 'selected' ? { allowedCanvasIds: selectedCanvasIds } : {}), ...(toolScope === 'selected' ? { tools: selectedTools } : {}) }) });
      setCreated({ name: name.trim(), token: result.token });
      setName('');
      setCanvasScope('all'); setSelectedCanvasIds([]); setToolScope('all'); setSelectedTools([]);
      onSettings(result.settings);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create a token.'); }
  }

  async function revoke(id: string, tokenName: string) {
    if (!window.confirm(`Revoke “${tokenName}” now? This takes effect immediately and connected clients will lose access.`)) return;
    setError('');
    try { onSettings(await api<ChatSettings>(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke the token.'); }
  }

  const claudeJson = JSON.stringify({ mcpServers: { 'symbiknow': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${envToken}` } } } }, null, 2);
  const claudeCli = `claude mcp add --transport http symbiknow ${endpoint} \\\n  --header "Authorization: Bearer \${SYMBIKNOW_MCP_TOKEN}"`;
  const codexToml = `[mcp_servers.symbiknow]\nurl = "${endpoint}"\nbearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"`;
  const genericJson = JSON.stringify({ mcpServers: { 'symbiknow': { url: endpoint, headers: { Authorization: `Bearer ${envToken}` } } } }, null, 2);
  const localStdio = JSON.stringify({ mcpServers: { 'symbiknow': { command: 'npm', args: ['run', 'mcp'], env: { CANVAS_API_URL: `${info?.origin ?? window.location.origin}/api` } } } }, null, 2);

  return <>
    <div className={`connection-banner${local ? ' connection-banner--warn' : ''}`}>
      <strong>Endpoint</strong><code>{endpoint}</code><CopyButton text={endpoint}/>
      <p>{local
        ? 'This address only works on this computer. On your server, set PUBLIC_URL to the address agents use (for example https://symbiknow.example.com), bind with HOST=0.0.0.0 behind HTTPS, and set SYMBIKNOW_ACCESS_TOKEN to protect the workspace.'
        : `Agents anywhere can connect over Streamable HTTP with a token.${info?.accessProtected ? ' The workspace is protected by an access token.' : ' Set SYMBIKNOW_ACCESS_TOKEN on the server so only your team can open the workspace.'} ${info?.activeSessions ? `${info.activeSessions} active MCP session${info.activeSessions === 1 ? '' : 's'}.` : ''}`}</p>
    </div>

    <div className="connection-card">
      <div className="connection-card__top"><strong>Access tokens</strong><span className="connection-card__status">{settings.mcpTokens?.length ?? 0} active</span></div>
      <p>Tokens take effect immediately, even when other Settings changes are pending. Each agent has its own access level, and its name appears as author in file history.</p>
      {/* Not a form: this sits inside the settings form, and forms cannot nest. */}
      <div className="token-form">
        <label>Token name<input aria-label="Token name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Ben’s laptop – Claude Code"
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createToken(); } }}/></label>
        <label>Workspace access<select aria-label="Token access" value={access} onChange={event => {
          const nextAccess = event.target.value as typeof access;
          setAccess(nextAccess);
          const allowed = toolsForAccess(nextAccess);
          setSelectedTools(tools => tools.filter(tool => allowed.includes(tool)));
        }}>
          <option value="read">Read only</option><option value="propose">Read and propose changes</option><option value="write">Read and make changes</option>
        </select><small>{access === 'read' ? 'Can read workspace documents and tasks.' : access === 'propose' ? 'Can read and propose edits for a person to approve.' : 'Can read and make workspace changes.'}</small></label>
        <label>Canvas scope<select aria-label="Canvas scope" value={canvasScope} onChange={event => setCanvasScope(event.target.value as typeof canvasScope)}>
          <option value="all">All canvases</option><option value="selected">Selected canvases</option>
        </select><small>{canvasScope === 'all' ? 'The token can access canvases across every workspace.' : 'The token is limited to the canvases selected below.'}</small></label>
        {canvasScope === 'selected' && <div className="token-scope-picker" aria-label="Select canvases">
          {workspaceError && <p role="alert">{workspaceError} <button type="button" className="activity-history-link" onClick={() => void loadWorkspaces()}>Retry</button></p>}
          {workspaces === null && !workspaceError && <p>Loading canvases…</p>}
          {workspaces?.flatMap(workspace => workspace.canvases.map(canvas => <label key={canvas.id}>
            <input type="checkbox" checked={selectedCanvasIds.includes(canvas.id)} disabled={!selectedCanvasIds.includes(canvas.id) && selectedCanvasIds.length >= 100}
              onChange={event => setSelectedCanvasIds(ids => event.target.checked ? [...ids, canvas.id] : ids.filter(id => id !== canvas.id))}/>{workspace.name} · {canvas.name}
          </label>))}
          {workspaces && !workspaces.some(workspace => workspace.canvases.length) && <p>No canvases are available.</p>}
          {selectedCanvasIds.length === 0 && <small>Select at least one canvas.</small>}
          {selectedCanvasIds.length >= 100 && <small>Tokens can be limited to at most 100 canvases.</small>}
        </div>}
        <label>Tool scope<select aria-label="Tool scope" value={toolScope} onChange={event => setToolScope(event.target.value as typeof toolScope)}>
          <option value="all">All tools allowed by access level</option><option value="selected">Selected tools</option>
        </select><small>{toolScope === 'all' ? 'Uses the full tool set permitted by the selected access level.' : 'Only checked tools will be available to this token.'}</small></label>
        {toolScope === 'selected' && <div className="token-scope-picker" aria-label="Select MCP tools">
          {availableTools.map(tool => <label key={tool}><input type="checkbox" checked={selectedTools.includes(tool)} onChange={event => setSelectedTools(tools => event.target.checked
            ? [...tools, tool] : tools.filter(item => item !== tool))}/>{tool}</label>)}
          {selectedTools.length === 0 && <small>Select at least one tool.</small>}
        </div>}
        <button type="button" className="primary-button" disabled={!name.trim() || scopeInvalid || (canvasScope === 'selected' && workspaces === null)} onClick={() => void createToken()}>Create token</button>
      </div>
      {created && <div className="token-created" role="status"><strong>Copy this token now. It is shown once and never included in shared setup instructions.</strong><code>{created.token}</code><CopyButton text={created.token} label="Copy token"/></div>}
      {error && <p className="version-panel__error" role="alert">{error}</p>}
      <ul className="token-list">{settings.mcpTokens?.map(item => <li key={item.id}>
        <span><strong>{item.name}</strong><small>{item.preview}{` · ${item.access ?? 'write'} access`} · created {new Date(item.createdAt).toLocaleDateString()}{item.lastUsedAt ? ` · last used ${new Date(item.lastUsedAt).toLocaleString()}` : ' · not used yet'}</small>
          <small className="token-scope-summary">{effectiveTokenScope(item, workspaces)}</small></span>
        <button type="button" className="secondary-button" onClick={() => void revoke(item.id, item.name)}>Revoke</button></li>)}</ul>
    </div>

    <McpActivity info={info} infoError={infoError} onRetryInfo={() => void loadInfo()} onOpenHistory={onOpenHistory} workspaces={workspaces}/>

    <label className="client-picker">Choose your MCP client<select aria-label="MCP client" value={client} onChange={event => setClient(event.target.value)}>
      <option value="">Choose a client to see setup instructions</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option>
      <option value="connector">Claude.ai / Claude Desktop connector</option><option value="generic">Other mcp.json client</option>
    </select></label>
    {client === 'claude-code' && <><Snippet title="Claude Code · .mcp.json" code={claudeJson}
      note={<>This config is safe to share with the repo. Set <code>SYMBIKNOW_MCP_TOKEN</code> in your shell before connecting.</>}/>
      <Snippet title="Claude Code · one command" code={claudeCli} note="Set the environment variable first, then run this command."/></>}
    {client === 'codex' && <Snippet title="Codex · ~/.codex/config.toml" code={codexToml} note={<>Add this block and export <code>SYMBIKNOW_MCP_TOKEN</code> before starting Codex.</>}/>}
    {client === 'generic' && <Snippet title="mcp.json" code={genericJson} note="Keep the bearer token in the SYMBIKNOW_MCP_TOKEN environment variable; this file can be shared."/>}
    {client === 'connector' && <div className="connection-card"><strong>Claude.ai / Claude Desktop connector</strong>
      <p>The connector URL contains your token. Copy it only into your private client settings.</p>
      {created ? <><code className="connector-secret">{`${endpoint}/t/${created.token}`}</code><CopyButton text={`${endpoint}/t/${created.token}`} label="Copy private connector URL"/></>
        : <p>Create a token above first. Its raw value is shown once.</p>}</div>}
    <details className="connection-details"><summary>Local development on this machine (stdio)</summary>
      <Snippet title="stdio · runs from a checkout of this repo" code={localStdio}
        note="Only for agents on the same machine as a clone of this project. Remote agents should use the HTTP endpoint above."/>
      <p className="settings-note">WebMCP lets an agent drive an open browser tab through the local <code>webmcp</code> bridge. It also only works on the same machine.</p>
    </details>
  </>;
}

function McpActivity({ info, infoError, onRetryInfo, onOpenHistory, workspaces }: {
  info: McpInfo | null; infoError: string; onRetryInfo: () => void; onOpenHistory?: OpenActivityHistory;
  workspaces: WorkspaceSummary[] | null;
}) {
  const [entries, setEntries] = useState<McpActivityEntry[] | null>(null);
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
    <div className="activity-health" aria-label="MCP connection health">
      <div><strong>Connection health</strong>{infoError ? <span className="activity-health__error">Unavailable</span>
        : info ? <span className="activity-health__ok">Status available</span> : <span>Checking…</span>}</div>
      {info ? <p>{info.publicUrlConfigured ? 'Public endpoint configured.' : 'Public endpoint is not configured; remote clients may not be able to connect.'}
        {' '}{info.accessProtected ? 'Workspace access protection is enabled.' : 'Workspace access protection is not enabled.'}
        {' '}{info.activeSessions} active session{info.activeSessions === 1 ? '' : 's'} reported.</p>
        : infoError && <p role="alert">{infoError}</p>}
      {infoError && <button type="button" className="secondary-button" onClick={onRetryInfo}>Retry connection check</button>}
    </div>
    <div className="activity-list-heading"><strong>Recent tool calls</strong>
      <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh activity'}</button></div>
    {loading && <p className="activity-state" role="status">Loading recent agent activity…</p>}
    {error && <div className="activity-error" role="alert"><span>{error}</span><button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
    {!loading && !error && entries?.length === 0 && <p className="activity-state">No recent tool calls are recorded. Agents can connect from the client instructions above.</p>}
    {!loading && !error && Boolean(entries?.length) && <ol className="activity-list">{entries?.map(entry => <li key={entry.id}>
      <div className="activity-entry__top"><strong>{entry.tool}</strong><span className={`activity-outcome activity-outcome--${entry.outcome}`}>{entry.outcome}</span></div>
      <p>{entry.tokenName} · {entry.access} access · {new Date(entry.startedAt).toLocaleString()}
        {entry.endedAt ? ` · finished ${new Date(entry.endedAt).toLocaleTimeString()}` : ''}</p>
      <p className="activity-entry__scope"><strong>Effective scope:</strong> {effectiveTokenScope({ access: entry.access,
        allowedCanvasIds: entry.allowedCanvasIds, tools: entry.tools }, workspaces)}</p>
      {entry.error && <p className="activity-entry__error">{entry.error}</p>}
      {(entry.canvasIds ?? []).length > 0 && <p><strong>Canvas:</strong> {entry.canvasIds.join(', ')}</p>}
      {(entry.documentIds ?? []).length > 0 && <p><strong>Documents:</strong> {entry.documentIds.join(', ')}</p>}
      {entry.revision && <p><strong>Revision:</strong> <code>{entry.revision}</code>{onOpenHistory && entry.canvasIds[0] && entry.documentIds[0] && <>{' '}<button type="button" className="activity-history-link"
        onClick={() => onOpenHistory(entry.canvasIds[0], entry.documentIds[0], entry.revision!)}>Inspect in document History</button></>}</p>}
    </li>)}</ol>}
    <p className="activity-caveat">A token’s last-used time shows its most recent observed use. It does not summarize every call; use the entries above for recent reads, changes, and failures.</p>
  </section>;
}
