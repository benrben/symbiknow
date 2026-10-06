import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CanvasApi } from './mcp-api.js';
import { scopedRegistration } from './mcp-scope.js';
import { registerDocumentTools, registerFileTools, registerCoordinationTools, registerVersionTools } from './mcp-tools.js';
import { registerJevTools } from './mcp-jev-tools.js';
import { registerSymbiBrainTools } from './mcp-brain-tools.js';
import type { ProjectMcpOptions } from './mcp-options.js';
export type { ProjectMcpOptions } from './mcp-options.js';
export { canCallMcpTool } from './mcp-scope.js';

const defaultApi = `http://127.0.0.1:${process.env.PORT || '8787'}/api`;
const instructions = `SymbiKnow is an infinite canvas where people and AI organize ideas and build knowledge together. Each document is a Markdown file that people and agents can connect, group, edit, and review.
Workflow for editing safely:
1. Use ask_symbi to find knowledge by semantic, logic, or combined evidence, and symbi_reflex to check a claim. read_canvas with includeContent=false gives a bounded metadata view; read_doc returns full source and contentHash.
2. claim_doc before a longer edit so other agents see you are working on it; release_doc when done.
3. edit_doc or upload_file with expectedContentHash to avoid overwriting someone else's change. Every content change is a Git revision attributed to you.
Each document has its own Git history: list_versions, create_branch, branch-targeted read_doc/edit_doc, merge_branch, restore_revision. switch_branch changes the shared visible document for everyone.
`;

const knownClients: Record<string, string> = {
  'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', cursor: 'Cursor', 'cursor-vscode': 'Cursor',
};

function apiToken() { return process.env.CANVAS_API_TOKEN || process.env.SYMBIKNOW_ACCESS_TOKEN || process.env.ALLTEAM_ACCESS_TOKEN; }
function clientName(server: McpServer) { return server.server.getClientVersion()?.name ?? ''; }
function agentName(client: string) {
  return process.env.SYMBIKNOW_AGENT_NAME || process.env.ALLTEAM_AGENT_NAME || knownClients[client.toLowerCase()] || client || 'MCP agent';
}

export function createProjectMcpServer(apiBase = process.env.CANVAS_API_URL || defaultApi, fetcher: typeof fetch = fetch,
  options: ProjectMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'symbiknow', version: '0.2.0' }, { instructions });
  const token = apiToken();
  const actor = () => {
    const client = clientName(server);
    const name = agentName(client);
    return [name, options.actorSuffix].filter(Boolean).join(' - ').slice(0, 48);
  };
  const api = new CanvasApi(apiBase.replace(/\/$/, ''), fetcher, () => ({
    'x-symbiknow-actor': actor(), 'x-symbiknow-agent-transport': 'mcp', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers,
  }));
  const registration = scopedRegistration(server, options);
  registerDocumentTools(registration, api);
  registerFileTools(registration, api, options.localFiles ?? true);
  registerCoordinationTools(registration, api);
  registerVersionTools(registration, api);
  registerSymbiBrainTools(registration, api);
  if (options.legacyBrainTools || process.env.SYMBIKNOW_LEGACY_BRAIN_TOOLS === '1'
    || options.tools?.some(name => ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_do', 'jev_job', 'jev_propose'].includes(name))) {
    registerJevTools(registration, api);
  }
  return server;
}

/** Connect a server and retain its lifecycle handle for embedded hosts. */
export async function connectProjectMcpServer(transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = createProjectMcpServer();
  await server.connect(transport);
  return server;
}

export async function startProjectMcpServer(transport?: Transport): Promise<void> {
  await connectProjectMcpServer(transport);
}

export async function runProjectMcpCli(moduleUrl: string, args = process.argv, start = startProjectMcpServer): Promise<void> {
  if (!args[1] || path.resolve(args[1]) !== fileURLToPath(moduleUrl)) return;
  try { await start(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

void runProjectMcpCli(import.meta.url);
