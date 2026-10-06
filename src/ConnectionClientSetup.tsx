import { useState } from 'react';
import { CopyButton, Snippet } from './ConnectionCopy';
import type { McpInfo } from './connection-types';

export function ConnectionClientSetup({ info, created }: { info: McpInfo | null; created: { name: string; token: string } | null }) {
  const [client, setClient] = useState('');
  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const envToken = '${SYMBIKNOW_MCP_TOKEN}';
  const claudeJson = JSON.stringify({ mcpServers: { 'symbiknow': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${envToken}` } } } }, null, 2);
  const claudeCli = `claude mcp add --transport http symbiknow ${endpoint} \\\n  --header "Authorization: Bearer \${SYMBIKNOW_MCP_TOKEN}"`;
  const codexToml = `[mcp_servers.symbiknow]\nurl = "${endpoint}"\nbearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"`;
  const genericJson = JSON.stringify({ mcpServers: { 'symbiknow': { url: endpoint, headers: { Authorization: `Bearer ${envToken}` } } } }, null, 2);
  const localStdio = JSON.stringify({ mcpServers: { 'symbiknow': { command: 'npm', args: ['run', 'mcp'], env: { CANVAS_API_URL: `${info?.origin ?? window.location.origin}/api` } } } }, null, 2);

  return <>
    <label className="client-picker">Choose your MCP client<select aria-label="MCP client" value={client} onChange={event => setClient(event.target.value)}>
      <option value="">Choose a client to see setup instructions</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option>
      <option value="connector">Claude.ai / Claude Desktop connector</option><option value="generic">Other mcp.json client</option>
    </select></label>
    <ClientInstructions client={client} endpoint={endpoint} created={created} codes={{ claudeJson, claudeCli, codexToml, genericJson }}/>
    <details className="connection-details"><summary>Local development on this machine (stdio)</summary>
      <Snippet title="stdio · runs from a checkout of this repo" code={localStdio}
        note="Only for agents on the same machine as a clone of this project. Remote agents should use the HTTP endpoint above."/>
      <p className="settings-note">WebMCP lets an agent drive an open browser tab through the local <code>webmcp</code> bridge. It also only works on the same machine.</p>
    </details>
  </>;
}

function ClientInstructions({ client, endpoint, created, codes }: { client: string; endpoint: string; created: { name: string; token: string } | null; codes: { claudeJson: string; claudeCli: string; codexToml: string; genericJson: string } }) {
  const { claudeJson, claudeCli, codexToml, genericJson } = codes;
  if (client === 'claude-code') return <><Snippet title="Claude Code · .mcp.json" code={claudeJson}
    note={<>This config is safe to share with the repo. Set <code>SYMBIKNOW_MCP_TOKEN</code> in your shell before connecting.</>}/>
    <Snippet title="Claude Code · one command" code={claudeCli} note="Set the environment variable first, then run this command."/></>;
  if (client === 'codex') return <Snippet title="Codex · ~/.codex/config.toml" code={codexToml} note={<>Add this block and export <code>SYMBIKNOW_MCP_TOKEN</code> before starting Codex.</>}/>;
  if (client === 'generic') return <Snippet title="mcp.json" code={genericJson} note="Keep the bearer token in the SYMBIKNOW_MCP_TOKEN environment variable; this file can be shared."/>;
  if (client === 'connector') return <div className="connection-card"><strong>Claude.ai / Claude Desktop connector</strong>
      <p>The connector URL contains your token. Copy it only into your private client settings.</p>
      {created ? <><code className="connector-secret">{`${endpoint}/t/${created.token}`}</code><CopyButton text={`${endpoint}/t/${created.token}`} label="Copy private connector URL"/></>
        : <p>Create a token above first. Its raw value is shown once.</p>}</div>;
  return null;
}
