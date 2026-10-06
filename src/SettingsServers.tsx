import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ExternalMcpServer } from '../shared/types';
import { api } from './api';
import type { TestedTool } from './settings-page-types';
import { uniqueSettingsId } from './settings-page-values';

export function ServersEditor({ servers, secretNames, onChange }: { servers: ExternalMcpServer[]; secretNames: string[]; onChange: (servers: ExternalMcpServer[]) => void }) {
  const [draft, setDraft] = useState({ name: '', url: '', bearerSecret: '' });
  const [results, setResults] = useState<Record<string, { message: string; tools?: TestedTool[] }>>({});
  const requests = useRef(new Map<string, symbol>());
  useEffect(() => {
    requests.current.delete('draft');
    setResults(current => { const next = { ...current }; delete next.draft; return next; });
  }, [draft]);
  useEffect(() => () => { requests.current.clear(); }, []);
  async function test(server: Pick<ExternalMcpServer, 'name' | 'url' | 'bearerSecret' | 'headers'> & { id?: string }, key: string) {
    const request = Symbol(key); requests.current.set(key, request);
    setResults(current => ({ ...current, [key]: { message: 'Connecting…' } }));
    try {
      const result = await api<{ tools: TestedTool[] }>('/mcp/servers/test', { method: 'POST', body: JSON.stringify(server) });
      if (requests.current.get(key) === request) setResults(current => ({ ...current, [key]: { message: `Connected · ${result.tools.length} tools`, tools: result.tools } }));
    } catch (failure) {
      if (requests.current.get(key) === request) setResults(current => ({ ...current, [key]: { message: failure instanceof Error ? failure.message : 'Could not connect.' } }));
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
      {results[server.id] && <div className="servers-editor__result" role="status"><p>{results[server.id].message}</p>{results[server.id].tools?.map(tool => <span key={tool.name}>{tool.name}{tool.capabilities?.length ? ` · ${tool.capabilities.join(', ')}` : tool.description ? ` · ${tool.description}` : ''}</span>)}</div>}
    </div>)}
    <div className="servers-editor__new">
      <label>Server name<input aria-label="MCP server name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="GitHub"/></label>
      <label>Server URL<input aria-label="MCP server URL" type="url" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp"/></label>
      <label>Auth secret<select aria-label="Authorization secret" value={draft.bearerSecret} onChange={event => setDraft({ ...draft, bearerSecret: event.target.value })}>
        <option value="">No authorization</option>{secretNames.map(name => <option key={name} value={name}>Bearer {name}</option>)}</select></label>
      <button type="button" className="secondary-button" disabled={!draft.url} onClick={() => void test({ ...draft, name: draft.name || 'MCP server', bearerSecret: draft.bearerSecret || undefined }, 'draft')}>Test</button>
      <button type="button" className="secondary-button" disabled={!draft.name.trim() || !/^https?:\/\//.test(draft.url)} onClick={() => {
        const base = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
        onChange([...servers, { id: uniqueSettingsId(base, servers), name: draft.name.trim(), url: draft.url.trim(), enabled: true,
          ...(draft.bearerSecret ? { bearerSecret: draft.bearerSecret } : {}), headers: {} }]);
        setDraft({ name: '', url: '', bearerSecret: '' });
      }}>Add server</button>
    </div>
    {results.draft && <div className="servers-editor__result" role="status"><p>{results.draft.message}</p>{results.draft.tools?.map(tool => <span key={tool.name}>{tool.name}{tool.capabilities?.length ? ` · ${tool.capabilities.join(', ')}` : tool.description ? ` · ${tool.description}` : ''}</span>)}</div>}
    <small>Remote Streamable HTTP or SSE servers only. Save secrets first, then save settings after adding a server.</small>
  </div>;
}
