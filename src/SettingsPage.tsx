import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Bot, Check, Copy, KeyRound, Plug, PlugZap, Puzzle, Server, Sparkles, Trash2 } from 'lucide-react';
import type { AgentPlugin, AgentProfile, ChatSettings, ExternalMcpServer, GroupBy, ModelProvider } from '../shared/types';
import { groupByLabels } from '../shared/groups';
import { defaultJevPolicy, effectiveJevPolicy, policyScale, type ActionKind, type JevPolicy } from '../shared/policy';
import { api } from './api';
import './settings.css';

export type SettingsPayload = Record<string, unknown>;
type SectionId = 'models' | 'agents' | 'secrets' | 'servers' | 'connect' | 'plugins' | 'jev';
type ModelOption = { id: string; name: string; tools?: boolean; context?: number };
type McpInfo = { origin: string; endpoint: string; publicUrlConfigured: boolean; accessProtected: boolean; activeSessions: number };
type FeedbackBucket = { category: string; bucket: string; applied: number; dismissed: number; applyRate: number };
type JevUsageTotals = { requests: number; questions: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
type JevUsageSummary = { model: string; month: JevUsageTotals; today: JevUsageTotals };
type CalibrationSuggestion = { kind: ActionKind; suggestedShow: number | null; sampleSize: number; note?: string };

const sections: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'models', label: 'Models', icon: <Sparkles size={15}/> },
  { id: 'agents', label: 'Agents & secrets', icon: <Bot size={15}/> },
  { id: 'secrets', label: 'Secrets', icon: <KeyRound size={15}/> },
  { id: 'servers', label: 'MCP servers', icon: <Server size={15}/> },
  { id: 'connect', label: 'MCP connections', icon: <PlugZap size={15}/> },
  { id: 'plugins', label: 'Plugins & loaders', icon: <Puzzle size={15}/> },
  { id: 'jev', label: 'TypeSafe Jev', icon: <Plug size={15}/> },
];

const providerInfo: Record<ModelProvider, { name: string; glyph: string; description: string; placeholder: string }> = {
  openrouter: { name: 'OpenRouter', glyph: '↗', description: 'Hundreds of models behind one key', placeholder: 'sk-or-v1-…' },
  openai: { name: 'OpenAI', glyph: '◎', description: 'GPT and o-series models', placeholder: 'sk-…' },
  anthropic: { name: 'Anthropic', glyph: 'A', description: 'Claude models', placeholder: 'sk-ant-…' },
  custom: { name: 'OpenAI-compatible', glyph: '⌘', description: 'Ollama, vLLM, LM Studio, or a gateway', placeholder: 'Optional' },
};

const builtInProfiles: AgentProfile[] = [
  { id: 'general', name: 'General assistant', instructions: 'Help with any canvas task and explain the result clearly.' },
  { id: 'research', name: 'Researcher', instructions: 'Investigate relevant documents, compare evidence, and cite document titles.' },
  { id: 'planner', name: 'Planner', instructions: 'Turn goals into ordered steps, dependencies, owners, and next actions.' },
  { id: 'builder', name: 'Builder', instructions: 'Focus on concrete document edits and verify saved changes.' },
];

const pluginInfo: Array<{ id: AgentPlugin; title: string; detail: string }> = [
  { id: 'document_read', title: 'Read documents', detail: 'Search and read canvas files.' },
  { id: 'document_write', title: 'Edit documents', detail: 'Create, edit, move, link, and delete files when requested.' },
  { id: 'jev_insights', title: 'Jev intelligence', detail: 'Analyze, regroup, connect, classify, and review with TypeSafe Jev.' },
  { id: 'tasks', title: 'Shared tasks', detail: 'Read and update the task board that people, Codex, and Claude Code share.' },
  { id: 'external_mcp', title: 'Outside MCP servers', detail: 'Use tools from the MCP servers you connect below.' },
];

const allPlugins = pluginInfo.map(item => item.id);

const policyLabels: Record<ActionKind, string> = {
  link: 'Connect documents', unlink: 'Remove links', label: 'Purpose, work area, and tags', tag: 'Suggest tags', reviewer: 'Assign reviewers',
  loader: 'Change loader', merge: 'Merge documents', merge_safe: 'Merge is safe', cross_link: 'Connect across canvases', task_update: 'Update tasks',
  authorize: 'Authorize chat changes', verify: 'Verify answers', stale: 'Flag stale content', steps: 'Flag missing steps',
  conflict: 'Flag conflicting documents', gap: 'Flag documentation gaps', reflected: 'Flag decisions not reflected',
  layout: 'Canvas layout', move: 'Move to a canvas', route: 'Route chat intent',
};

function validJevPolicy(policy: JevPolicy): boolean {
  return Object.values(policy).every(({ show, apply }) =>
    Number.isFinite(show) && Number.isFinite(apply) && show >= 0 && show <= apply && apply <= 1);
}

function FeedbackTable() {
  const [buckets, setBuckets] = useState<FeedbackBucket[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<FeedbackBucket[]>('/settings/jev-feedback').then(result => { if (active) setBuckets(result); })
      .catch(() => { if (active) setError('Feedback rates are unavailable right now.'); });
    return () => { active = false; };
  }, []);
  return <div style={{ marginTop: 18 }}>
    <div className="settings-subheading">Suggestion feedback</div>
    <p className="settings-note">Apply rates count decisions by category and confidence. Threshold suggestions appear after enough reviewed decisions and never change settings automatically.</p>
    {error && <p className="settings-note">{error}</p>}
    {buckets?.length === 0 && <p className="settings-note">No suggestion feedback recorded yet.</p>}
    {buckets && buckets.length > 0 && <table aria-label="Jev feedback rates" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
      <thead><tr><th scope="col">Category</th><th scope="col">Confidence</th><th scope="col">Applied</th><th scope="col">Dismissed</th><th scope="col">Apply rate</th><th scope="col">Suggestion</th></tr></thead>
      <tbody>{buckets.map(bucket => {
        const suggest = bucket.bucket === '0.75–0.85' && bucket.applied + bucket.dismissed >= 20 && bucket.applyRate >= 0.9;
        return <tr key={`${bucket.category}:${bucket.bucket}`}>
          <th scope="row" style={{ textAlign: 'left', padding: 6 }}>{bucket.category.replaceAll('_', ' ')}</th>
          <td style={{ padding: 6 }}>{bucket.bucket}</td><td style={{ padding: 6 }}>{bucket.applied}</td><td style={{ padding: 6 }}>{bucket.dismissed}</td>
          <td style={{ padding: 6 }}>{Math.round(bucket.applyRate * 100)}%</td>
          <td style={{ padding: 6 }}>{suggest ? 'Consider lowering Apply to 0.75' : '—'}</td>
        </tr>;
      })}</tbody>
    </table>}
  </div>;
}

function UsageSummary() {
  const [usage, setUsage] = useState<JevUsageSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<JevUsageSummary>('/jev/usage').then(result => { if (active && result?.month) setUsage(result); })
      .catch(() => { if (active) setError('Usage is unavailable right now.'); });
    return () => { active = false; };
  }, []);
  if (error) return <p className="settings-note" role="alert">{error}</p>;
  if (!usage) return null;
  const tokens = usage.month.inputTokens + usage.month.outputTokens;
  return <div className="connection-card" aria-label="Jev usage this month">
    <div className="connection-card__top"><strong>Usage</strong><span className="connection-card__status">{usage.model}</span></div>
    <p className="settings-note">This month: {usage.month.requests.toLocaleString()} requests, {tokens.toLocaleString()} tokens, ${usage.month.estimatedCostUsd.toFixed(4)} estimated.</p>
  </div>;
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

function Section({ id, title, description, children }: { id: SectionId; title: string; description: string; children: ReactNode }) {
  return <section className="settings-page__section" id={`settings-${id}`} data-section={id} aria-labelledby={`settings-${id}-title`}>
    <div className="settings-page__section-heading"><h3 id={`settings-${id}-title`}>{title}</h3><p>{description}</p></div>
    {children}
  </section>;
}

function ModelPicker({ provider, value, onChange, ready }: { provider: ModelProvider; value: string; onChange: (value: string) => void; ready: boolean }) {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setModels(null); setError(''); }, [provider]);

  async function load() {
    setOpen(true);
    if (models || loading) return;
    setLoading(true);
    setError('');
    try { setModels(await api<ModelOption[]>(`/models?provider=${provider}`)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load models.'); }
    finally { setLoading(false); }
  }

  const shown = (models ?? []).filter(model => `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 80);
  return <div className="model-picker">
    <label>Model<input aria-label="Model" required value={value} onChange={event => onChange(event.target.value)} placeholder="provider/model-id"/>
      <small>Pick a model that supports tool calling. {ready ? 'Browse the provider’s current list:' : 'Save a key first to browse models.'}</small></label>
    <button type="button" className="secondary-button" onClick={() => void load()} disabled={!ready && provider !== 'openrouter'}>{open ? 'Refresh list' : 'Browse models'}</button>
    {open && <div className="model-picker__panel">
      <input aria-label="Filter models" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter by name…"/>
      {loading && <p className="model-picker__note">Loading models…</p>}
      {error && <p className="model-picker__note model-picker__note--error" role="alert">{error}</p>}
      {models && <ul role="listbox" aria-label="Available models">{shown.map(model => <li key={model.id}>
        <button type="button" role="option" aria-selected={model.id === value} onClick={() => { onChange(model.id); setOpen(false); }}>
          <span><strong>{model.name}</strong><code>{model.id}</code></span>
          <span className="model-picker__badges">{model.tools && <em>tools</em>}{model.context ? <em>{Math.round(model.context / 1000)}k</em> : null}</span>
        </button></li>)}
        {!shown.length && <li className="model-picker__note">No models match.</li>}
      </ul>}
    </div>}
  </div>;
}

function ProfileEditor({ profiles, onChange }: { profiles: AgentProfile[]; onChange: (profiles: AgentProfile[]) => void }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  function add() {
    if (!name.trim() || !instructions.trim()) return;
    onChange([...profiles, { id: `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'}`, name: name.trim(), instructions: instructions.trim() }]);
    setName('');
    setInstructions('');
  }
  return <div className="profile-editor">
    {profiles.map((profile, index) => <div className="profile-editor__item" key={profile.id}>
      <input aria-label={`Name for ${profile.name}`} value={profile.name} onChange={event => onChange(profiles.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}/>
      <textarea aria-label={`Instructions for ${profile.name}`} rows={2} value={profile.instructions} onChange={event => onChange(profiles.map((item, position) => position === index ? { ...item, instructions: event.target.value } : item))}/>
      <button type="button" className="icon-button" aria-label={`Remove ${profile.name}`} onClick={() => onChange(profiles.filter((_, position) => position !== index))}><Trash2 size={14}/></button>
    </div>)}
    <div className="profile-editor__new">
      <input aria-label="New profile name" value={name} onChange={event => setName(event.target.value)} placeholder="Profile name, e.g. Sales coach"/>
      <textarea aria-label="New profile instructions" rows={2} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="How should this agent work?"/>
      <button type="button" className="secondary-button" onClick={add} disabled={!name.trim() || !instructions.trim()}>Add profile</button>
    </div>
  </div>;
}

function SecretsEditor({ names, pending, onPending }: { names: string[]; pending: Record<string, string | null>; onPending: (next: Record<string, string | null>) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valid = /^[A-Z][A-Z0-9_]{0,63}$/.test(name);
  const listed = [...new Set([...names, ...Object.keys(pending).filter(key => pending[key] !== null)])].sort();
  return <div className="secrets-editor">
    {listed.length === 0 && <p className="settings-empty">No secrets saved yet.</p>}
    {listed.map(secret => <div className="secrets-editor__row" key={secret}>
      <code>{secret}</code>
      <span>{pending[secret] === null ? 'Will be removed' : pending[secret] !== undefined ? 'Will be saved' : 'Saved'}</span>
      {pending[secret] === null
        ? <button type="button" className="secondary-button" onClick={() => { const next = { ...pending }; delete next[secret]; onPending(next); }}>Undo</button>
        : <button type="button" className="icon-button" aria-label={`Remove secret ${secret}`} onClick={() => {
          const next = { ...pending };
          if (names.includes(secret)) next[secret] = null; else delete next[secret];
          onPending(next);
        }}><Trash2 size={14}/></button>}
    </div>)}
    <div className="secrets-editor__new">
      <input aria-label="Secret name" value={name} onChange={event => setName(event.target.value.toUpperCase())} placeholder="GITHUB_TOKEN"/>
      <input aria-label="Secret value" type="password" autoComplete="new-password" value={value} onChange={event => setValue(event.target.value)} placeholder="Value"/>
      <button type="button" className="secondary-button" disabled={!valid || !value} onClick={() => { onPending({ ...pending, [name]: value }); setName(''); setValue(''); }}>Add secret</button>
    </div>
    <small>Use capital letters, digits, and underscores. Values never come back to the browser; reference them as <code>{'${secret:NAME}'}</code> in MCP headers.</small>
  </div>;
}

function ServersEditor({ servers, secretNames, onChange }: { servers: ExternalMcpServer[]; secretNames: string[]; onChange: (servers: ExternalMcpServer[]) => void }) {
  const [draft, setDraft] = useState({ name: '', url: '', bearerSecret: '' });
  const [results, setResults] = useState<Record<string, string>>({});
  async function test(server: Pick<ExternalMcpServer, 'name' | 'url' | 'bearerSecret' | 'headers'> & { id?: string }, key: string) {
    setResults(current => ({ ...current, [key]: 'Connecting…' }));
    try {
      const result = await api<{ tools: Array<{ name: string }> }>('/mcp/servers/test', { method: 'POST', body: JSON.stringify(server) });
      setResults(current => ({ ...current, [key]: `Reachable · ${result.tools.length} tools: ${result.tools.slice(0, 6).map(tool => tool.name).join(', ')}${result.tools.length > 6 ? '…' : ''}` }));
    } catch (failure) {
      setResults(current => ({ ...current, [key]: failure instanceof Error ? failure.message : 'Could not connect.' }));
    }
  }
  return <div className="servers-editor">
    {servers.length === 0 && <p className="settings-empty">No outside MCP servers yet. Add one to give the chat agent more tools.</p>}
    {servers.map((server, index) => <div className="servers-editor__row" key={server.id}>
      <label className="plugin-toggle servers-editor__toggle"><span><strong>{server.name}</strong><small>{server.url}{server.bearerSecret ? ` · Bearer ${server.bearerSecret}` : ''}</small></span>
        <input type="checkbox" aria-label={`Enable ${server.name}`} checked={server.enabled} onChange={() => onChange(servers.map((item, position) => position === index ? { ...item, enabled: !item.enabled } : item))}/></label>
      <div className="servers-editor__actions">
        <button type="button" className="secondary-button" onClick={() => void test(server, server.id)}>Test</button>
        <button type="button" className="icon-button" aria-label={`Remove ${server.name}`} onClick={() => onChange(servers.filter((_, position) => position !== index))}><Trash2 size={14}/></button>
      </div>
      {results[server.id] && <p className="servers-editor__result" role="status">{results[server.id]}</p>}
    </div>)}
    <div className="servers-editor__new">
      <input aria-label="MCP server name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Name, e.g. GitHub"/>
      <input aria-label="MCP server URL" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp"/>
      <select aria-label="Authorization secret" value={draft.bearerSecret} onChange={event => setDraft({ ...draft, bearerSecret: event.target.value })}>
        <option value="">No authorization</option>{secretNames.map(name => <option key={name} value={name}>Bearer {name}</option>)}</select>
      <button type="button" className="secondary-button" disabled={!draft.url} onClick={() => void test({ ...draft, name: draft.name || 'MCP server', bearerSecret: draft.bearerSecret || undefined }, 'draft')}>Test</button>
      <button type="button" className="secondary-button" disabled={!draft.name.trim() || !/^https?:\/\//.test(draft.url)} onClick={() => {
        onChange([...servers, { id: draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server', name: draft.name.trim(), url: draft.url.trim(), enabled: true,
          ...(draft.bearerSecret ? { bearerSecret: draft.bearerSecret } : {}), headers: {} }]);
        setDraft({ name: '', url: '', bearerSecret: '' });
      }}>Add server</button>
    </div>
    {results.draft && <p className="servers-editor__result" role="status">{results.draft}</p>}
    <small>Remote Streamable HTTP or SSE servers only. Save secrets first, then save settings after adding a server.</small>
  </div>;
}

function ConnectAgents({ settings, onSettings }: { settings: ChatSettings; onSettings: (settings: ChatSettings) => void }) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<McpInfo>('/mcp/info').then(setInfo).catch(() => setInfo(null)); }, []);
  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(endpoint);
  const token = created?.token ?? '<paste your token>';
  const envToken = created ? token : '${SYMBIKNOW_MCP_TOKEN}';

  async function createToken() {
    if (!name.trim()) return;
    setError('');
    try {
      const result = await api<{ token: string; settings: ChatSettings }>('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setCreated({ name: name.trim(), token: result.token });
      setName('');
      onSettings(result.settings);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create a token.'); }
  }

  async function revoke(id: string) {
    try { onSettings(await api<ChatSettings>(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke the token.'); }
  }

  const claudeJson = JSON.stringify({ mcpServers: { 'symbiknow': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${envToken}` } } } }, null, 2);
  const claudeCli = `claude mcp add --transport http symbiknow ${endpoint} \\\n  --header "Authorization: Bearer ${token}"`;
  const codexToml = `[mcp_servers.symbiknow]\nurl = "${endpoint}"\nbearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"`;
  const genericJson = JSON.stringify({ mcpServers: { 'symbiknow': { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const connectorUrl = `${endpoint}/t/${token}`;
  const localStdio = JSON.stringify({ mcpServers: { 'symbiknow': { command: 'npm', args: ['run', 'mcp'], env: { CANVAS_API_URL: `${info?.origin ?? window.location.origin}/api` } } } }, null, 2);

  return <>
    <div className={`connection-banner${local ? ' connection-banner--warn' : ''}`}>
      <strong>Endpoint</strong><code>{endpoint}</code><CopyButton text={endpoint}/>
      <p>{local
        ? 'This address only works on this computer. On your server, set PUBLIC_URL to the address agents use (for example https://symbiknow.example.com), bind with HOST=0.0.0.0 behind HTTPS, and set SYMBIKNOW_ACCESS_TOKEN to protect the workspace.'
        : `Agents anywhere can connect over Streamable HTTP with a token.${info?.accessProtected ? ' The workspace is protected by an access token.' : ' Set SYMBIKNOW_ACCESS_TOKEN on the server so only your team can open the workspace.'}`}</p>
    </div>

    <div className="connection-card">
      <div className="connection-card__top"><strong>Access tokens</strong><span className="connection-card__status">{settings.mcpTokens?.length ?? 0} active</span></div>
      <p>Each agent or machine gets its own token. Its name appears as the author of that agent’s edits in file history.</p>
      {/* Not a form: this sits inside the settings form, and forms cannot nest. */}
      <div className="token-form">
        <input aria-label="Token name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Ben’s laptop – Claude Code"
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createToken(); } }}/>
        <button type="button" className="primary-button" disabled={!name.trim()} onClick={() => void createToken()}>Create token</button>
      </div>
      {created && <div className="token-created" role="status"><strong>Copy this token now — it won’t be shown again.</strong><code>{created.token}</code><CopyButton text={created.token}/></div>}
      {error && <p className="version-panel__error" role="alert">{error}</p>}
      <ul className="token-list">{settings.mcpTokens?.map(item => <li key={item.id}>
        <span><strong>{item.name}</strong><small>{item.preview} · created {new Date(item.createdAt).toLocaleDateString()}{item.lastUsedAt ? ` · last used ${new Date(item.lastUsedAt).toLocaleString()}` : ' · not used yet'}</small></span>
        <button type="button" className="secondary-button" onClick={() => void revoke(item.id)}>Revoke</button></li>)}</ul>
    </div>

    <Snippet title="Claude Code · .mcp.json" code={claudeJson}
      note={<>Put this in your project’s <code>.mcp.json</code> (shared with the repo) and export <code>SYMBIKNOW_MCP_TOKEN</code> in your shell. Claude Code expands the variable when it connects.</>}/>
    <Snippet title="Claude Code · one command" code={claudeCli} note="Or register it for yourself from any folder."/>
    <Snippet title="Codex · ~/.codex/config.toml" code={codexToml} note={<>Add this block and export <code>SYMBIKNOW_MCP_TOKEN</code> before starting Codex.</>}/>
    <Snippet title="Claude.ai / Claude Desktop · custom connector" code={connectorUrl}
      note="Settings → Connectors → Add custom connector. Paste this URL; the token is part of the path because connectors cannot send headers. Treat the URL as a secret."/>
    <Snippet title="Cursor, Windsurf, VS Code, and other mcp.json clients" code={genericJson}/>
    <details className="connection-details"><summary>Local development on this machine (stdio)</summary>
      <Snippet title="stdio · runs from a checkout of this repo" code={localStdio}
        note="Only for agents on the same machine as a clone of this project. Remote agents should use the HTTP endpoint above."/>
      <p className="settings-note">WebMCP lets an agent drive an open browser tab through the local <code>webmcp</code> bridge. It also only works on the same machine.</p>
    </details>
  </>;
}

export function SettingsPage({ settings, busy, onSave, onCancel, onSettings }: {
  settings: ChatSettings;
  busy: boolean;
  onSave: (payload: SettingsPayload) => Promise<void>;
  onCancel: () => void;
  onSettings: (settings: ChatSettings) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    provider: settings.provider ?? 'openrouter', model: settings.model, baseUrl: settings.baseUrl ?? '', systemPrompt: settings.systemPrompt,
    reviewers: settings.reviewers, workAreas: settings.workAreas ?? '', tagVocabulary: settings.tagVocabulary ?? '', agentProfile: settings.agentProfile ?? 'general',
    customProfiles: settings.customProfiles ?? [], agentPlugins: settings.agentPlugins ?? allPlugins,
    mcpServers: settings.mcpServers ?? [], groupBy: settings.groupBy ?? 'work_area' as GroupBy,
    jevPolicy: effectiveJevPolicy(settings.jevPolicy),
  }));
  const [apiKey, setApiKey] = useState('');
  const [jevApiKey, setJevApiKey] = useState('');
  const [calibration, setCalibration] = useState<CalibrationSuggestion[]>([]);
  useEffect(() => {
    api<CalibrationSuggestion[]>('/jev/calibration').then(result => setCalibration(Array.isArray(result) ? result : [])).catch(() => setCalibration([]));
  }, []);
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [active, setActive] = useState<SectionId>('models');
  const scroller = useRef<HTMLDivElement>(null);
  const provider = providerInfo[draft.provider];
  const providerReady = draft.provider === settings.provider ? settings.hasApiKey : Boolean(settings.providerKeys?.[draft.provider]);
  const secretNames = useMemo(() => [...new Set([...(settings.secretNames ?? []), ...Object.keys(secrets).filter(key => secrets[key] !== null)])]
    .filter(name => secrets[name] !== null).sort(), [settings.secretNames, secrets]);

  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive((visible.target as HTMLElement).dataset.section as SectionId);
    }, { root, rootMargin: '0px 0px -65% 0px' });
    root.querySelectorAll('[data-section]').forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  function jump(id: SectionId) {
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function update<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) { setDraft(current => ({ ...current, [key]: value })); }

  function togglePlugin(id: AgentPlugin) {
    update('agentPlugins', draft.agentPlugins.includes(id) ? draft.agentPlugins.filter(item => item !== id) : [...draft.agentPlugins, id]);
  }

  function updateThreshold(kind: ActionKind, field: 'show' | 'apply', value: number) {
    update('jevPolicy', { ...draft.jevPolicy, [kind]: { ...draft.jevPolicy[kind], [field]: value } });
  }

  function useSuggestion(kind: ActionKind, suggestedShow: number) {
    update('jevPolicy', { ...draft.jevPolicy, [kind]: { show: suggestedShow, apply: Math.max(draft.jevPolicy[kind].apply, suggestedShow) } });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validJevPolicy(draft.jevPolicy)) return;
    const payload: SettingsPayload = {
      provider: draft.provider, model: draft.model.trim(), systemPrompt: draft.systemPrompt, reviewers: draft.reviewers, workAreas: draft.workAreas, tagVocabulary: draft.tagVocabulary,
      agentProfile: draft.agentProfile, customProfiles: draft.customProfiles, agentPlugins: draft.agentPlugins, groupBy: draft.groupBy,
      jevPolicy: draft.jevPolicy,
      mcpServers: draft.mcpServers.filter(server => !server.bearerSecret || secretNames.includes(server.bearerSecret)),
      ...(draft.provider === 'custom' ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...(Object.keys(secrets).length ? { secrets } : {}),
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    if (jevApiKey.trim()) payload.jevApiKey = jevApiKey.trim();
    await onSave(payload);
  }

  const profiles = [...builtInProfiles, ...draft.customProfiles];

  return <form onSubmit={submit} className="settings-page">
    <nav className="settings-page__nav" aria-label="Settings sections">{sections.map(section => <button type="button" key={section.id}
      className={active === section.id ? 'active' : ''} aria-current={active === section.id ? 'true' : undefined} onClick={() => jump(section.id)}>
      <span aria-hidden="true">{section.icon}</span>{section.label}</button>)}
      <p>Keys and secrets stay on the canvas server. The browser only learns whether they are set.</p></nav>
    <div className="settings-page__main"><div className="settings-page__scroll" ref={scroller}>
      <Section id="models" title="Models" description="Choose who runs the chat agent. Any provider with tool calling works with Deep Agents.">
        <div className="provider-grid" role="radiogroup" aria-label="Model provider">{(Object.keys(providerInfo) as ModelProvider[]).map(id => {
          const info = providerInfo[id];
          const ready = id === settings.provider ? settings.hasApiKey : Boolean(settings.providerKeys?.[id]);
          return <button type="button" role="radio" aria-checked={draft.provider === id} key={id} className={`provider-option${draft.provider === id ? ' is-selected' : ''}`}
            onClick={() => { update('provider', id); setApiKey(''); }}>
            <span className="provider-logo">{info.glyph}</span><span><strong>{info.name}</strong><small>{info.description}</small></span>
            <span className={'provider-status ' + (ready ? 'connected' : '')}>{ready ? 'Connected' : 'Not set'}</span>
          </button>;
        })}</div>
        {draft.provider === 'custom' && <label>Base URL<input value={draft.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://llm.example.com/v1"/>
          <small>An OpenAI-compatible <code>/v1</code> endpoint that the canvas server can reach.</small></label>}
        <label>{provider.name} API key<input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)}
          placeholder={providerReady ? 'Saved — enter a new key to replace' : provider.placeholder}/>
          <small>{providerReady ? 'A key is saved. It is never returned to this browser after saving.' : 'Stored on the canvas server and sent only to this provider.'}</small></label>
        <ModelPicker provider={draft.provider} value={draft.model} onChange={value => update('model', value)} ready={providerReady}/>
      </Section>

      <Section id="agents" title="Agents" description="Profiles set how the chat agent works. Tool access is chosen under Plugins.">
        <label>Agent profile<select value={draft.agentProfile} onChange={event => update('agentProfile', event.target.value)}>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>
          <small>{profiles.find(profile => profile.id === draft.agentProfile)?.instructions}</small></label>
        <div className="settings-subheading">Custom profiles</div>
        <ProfileEditor profiles={draft.customProfiles} onChange={value => update('customProfiles', value)}/>
        <label>System prompt<textarea rows={4} value={draft.systemPrompt} onChange={event => update('systemPrompt', event.target.value)} placeholder="How should Symbi work?"/></label>
      </Section>

      <Section id="secrets" title="Secrets" description="Named values for outside MCP servers and integrations. Saved with the rest of the settings.">
        <SecretsEditor names={settings.secretNames ?? []} pending={secrets} onPending={setSecrets}/>
      </Section>

      <Section id="servers" title="MCP servers" description="Connect outside MCP servers so the chat agent can use their tools, such as GitHub, Linear, or your own services.">
        <ServersEditor servers={draft.mcpServers} secretNames={secretNames} onChange={value => update('mcpServers', value)}/>
      </Section>

      <Section id="connect" title="Connect agents to this canvas" description="Give Codex, Claude Code, Claude.ai, and other MCP clients the same documents, tasks, locks, and file history. Nothing needs to run on their machine.">
        <ConnectAgents settings={settings} onSettings={onSettings}/>
      </Section>

      <Section id="plugins" title="Plugins & loaders" description="Choose which tool packs the chat agent can call. Canvas buttons and MCP clients keep their own controls.">
        {pluginInfo.map(item => <label className="plugin-toggle" key={item.id}><span><strong>{item.title}</strong><small>{item.detail}</small></span>
          <input type="checkbox" checked={draft.agentPlugins.includes(item.id)} onChange={() => togglePlugin(item.id)}/></label>)}
        <div className="settings-page__section-heading settings-page__section-heading--spaced"><h3>Installed canvas loaders</h3><p>These render document content in the canvas and full-page reader.</p></div>
        <div className="loader-list">{['Markdown + GFM', 'Shiki code', 'Mermaid diagrams', 'Marp slides', 'Video', 'MDX components', 'Interactive HTML', 'Full websites'].map(item => <span key={item}>✓ {item}</span>)}</div>
      </Section>

      <Section id="jev" title="TypeSafe Jev" description="Fast typed decisions for grouping, linking, labeling, reviewer suggestions, and chat safety checks.">
        <div className="provider-card"><div className="provider-logo">J</div><div><strong>TypeSafe Jev</strong><span>Direct Jev API for canvas insights and decisions</span></div>
          <span className={'provider-status ' + (settings.hasJevApiKey ? 'connected' : '')}>{settings.hasJevApiKey ? 'Connected' : 'Not configured'}</span></div>
        <label>TypeSafe Jev API key<input type="password" autoComplete="new-password" value={jevApiKey} onChange={event => setJevApiKey(event.target.value)} placeholder={settings.hasJevApiKey ? 'Saved — enter a new key to replace' : 'TypeSafe API key'}/><small>Stored on the canvas server. Jev requests go directly to TypeSafe.</small></label>
        <UsageSummary/>
        <label>Group documents by<select value={draft.groupBy} onChange={event => update('groupBy', event.target.value as GroupBy)}>
          {(Object.keys(groupByLabels) as GroupBy[]).map(value => <option key={value} value={value}>{groupByLabels[value]}</option>)}</select>
          <small>Used by Organize positions and Regroup & connect. The Insights dashboard can switch at any time.</small></label>
        <label>Review teams<textarea aria-label="Review teams" rows={3} maxLength={2000} value={draft.reviewers} onChange={event => update('reviewers', event.target.value)} placeholder={'Dana: backend, billing, Postgres\nAri: product strategy'}/><small>One reviewer per line. Add expertise after a colon, for example Dana: backend, billing, Postgres. Plain names and comma-separated names still work. Up to 2,000 characters.</small></label>
        <label>Extra work-area labels<textarea rows={2} value={draft.workAreas} onChange={event => update('workAreas', event.target.value)} placeholder="Developer relations, Field sales, Launch planning"/><small>Jev can choose from 120 built-in work areas plus these custom labels (up to 255 in total).</small></label>
        <label>Tag vocabulary<textarea aria-label="Tag vocabulary" rows={3} maxLength={2500} value={draft.tagVocabulary} onChange={event => update('tagVocabulary', event.target.value)} placeholder={'onboarding\nbilling\nrelease'}/><small>Tags Jev can suggest for documents. Enter one per line or separate them with commas. Up to 2,500 characters.</small></label>
        <div className="settings-subheading">Confidence</div>
        <p className="settings-note">Set each threshold from 0 to 1. Suggestions appear at Show and can be applied automatically at Apply. Merges always need a click.</p>
        <p className="settings-note">TypeSafe reports best accuracy in English; check thresholds for non-English documents with this data.</p>
        <table aria-label="Jev confidence thresholds" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr><th scope="col" style={{ textAlign: 'left', padding: 6 }}>Action</th><th scope="col" style={{ textAlign: 'left', padding: 6 }}>Scale</th><th scope="col" style={{ textAlign: 'left', padding: 6 }}>Show</th><th scope="col" style={{ textAlign: 'left', padding: 6 }}>Apply</th><th scope="col" style={{ textAlign: 'left', padding: 6 }}>Suggestion</th></tr></thead>
          <tbody>{(Object.keys(defaultJevPolicy) as ActionKind[]).map(kind => {
            const suggestion = calibration.find(item => item.kind === kind);
            return <tr key={kind}>
            <th scope="row" style={{ textAlign: 'left', padding: 6, fontWeight: 500 }}>{policyLabels[kind]}</th>
            <td style={{ padding: 6, color: '#6b7686' }}>{policyScale[kind] === 'probability' ? 'Probability' : 'Confidence'}</td>
            {(['show', 'apply'] as const).map(field => <td key={field} style={{ padding: 6 }}>
              <input type="number" aria-label={`${policyLabels[kind]} ${field}`} min={0} max={1} step={0.01} value={draft.jevPolicy[kind][field]}
                onChange={event => updateThreshold(kind, field, Number(event.target.value))}
                style={{ width: 74, padding: '5px 7px', border: '1px solid #dce3ed', borderRadius: 6 }}/>
            </td>)}
            <td style={{ padding: 6, color: '#6b7686' }}>{!suggestion ? '—'
              : suggestion.suggestedShow === null ? `${suggestion.note ?? 'Not enough data'} (n=${suggestion.sampleSize})`
              : <>{`Show ≥ ${suggestion.suggestedShow} (n=${suggestion.sampleSize})`}{' '}
                <button type="button" className="secondary-button" onClick={() => useSuggestion(kind, suggestion.suggestedShow!)}>Use</button></>}
            </td>
          </tr>;
          })}</tbody>
        </table>
        {!validJevPolicy(draft.jevPolicy) && <p role="alert">Each threshold must be between 0 and 1, and Show cannot exceed Apply.</p>}
        <FeedbackTable/>
      </Section>
    </div><footer className="settings-page__footer"><span>Changes apply to the next chat and automation.</span><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy || !validJevPolicy(draft.jevPolicy)}>Save settings</button></footer></div>
  </form>;
}
