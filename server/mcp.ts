import path from 'node:path';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CanvasApi } from './mcp-api.js';
import { scopedRegistration, installScopedDiscovery } from './mcp-scope.js';
import { projectMcpTools } from './mcp-registry.js';
import type { ProjectMcpOptions } from './mcp-options.js';
import { safeMcpToolEvent } from './mcp-activity.js';
export type { ProjectMcpOptions } from './mcp-options.js';
export { canCallMcpTool } from './mcp-scope.js';

const defaultApi = `http://127.0.0.1:${process.env.PORT || '8787'}/api`;
const instructions = `SymbiKnow is an infinite canvas where people and AI organize ideas and build knowledge together. Each document is a Markdown file that people and agents can connect, group, edit, and review.
Workflow for editing safely:
1. Use ask_symbi to find knowledge by semantic, logic, or combined evidence, and symbi_reflex to check a claim. read_canvas with includeContent=false gives a bounded metadata view; read_doc returns full source and contentHash.
2. claim_doc before a longer edit so other agents see you are working on it; release_doc when done.
3. download_file creates a working copy and authoritative checkout. Edit the file in your environment, then upload_file with mode=replace, checkoutId, and an idempotencyKey. Stale writes fail without overwriting another edit. mode=create creates a new document; mode=propose prepares a reviewable file change.
Each document has its own Git history: list_versions, create_branch, branch-targeted download_file/upload_file, merge_branch, restore_revision. switch_branch changes the shared visible document for everyone.
Canvas todos: list_todos, create_todo, update_todo, set_todo_status. Use the latest task revision as expectedRevision for updates. Setting status to done moves a task to Archive automatically; setting todo reopens it.
`;

const knownClients: Record<string, string> = {
  'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', cursor: 'Cursor', 'cursor-vscode': 'Cursor',
};

function apiToken() { return process.env.CANVAS_API_TOKEN || process.env.SYMBIKNOW_ACCESS_TOKEN || process.env.ALLTEAM_ACCESS_TOKEN; }
function clientName(server: McpServer) { return server.server.getClientVersion()?.name ?? ''; }
function agentName(client: string) {
  return process.env.SYMBIKNOW_AGENT_NAME || process.env.ALLTEAM_AGENT_NAME || knownClients[client.toLowerCase()] || client || 'MCP agent';
}
const callerSchema = z.object({ id: z.string().min(1), access: z.enum(['read', 'propose', 'write']),
  allowedCanvasIds: z.array(z.string()).optional(), tools: z.array(z.string()).optional(),
  canApprove: z.boolean().optional(), canConfigure: z.boolean().optional() });
function resolvesApiAuthority(options: ProjectMcpOptions, token: string | undefined) {
  return options.authoritativeApi || Boolean(token && !hasCustomAuthorization(options));
}
function hasCustomAuthorization(options: ProjectMcpOptions) {
  return Object.keys(options.headers ?? {}).some(name => name.toLowerCase() === 'authorization');
}
function tokenHeaders(options: ProjectMcpOptions, token: string | undefined): Record<string, string> {
  if (!token || hasCustomAuthorization(options)) return {};
  return { authorization: `Bearer ${token}` };
}
function apiAuthorityOptions(api: CanvasApi, options: ProjectMcpOptions, token: string | undefined, setCaller: (id: string) => void): ProjectMcpOptions {
  if (!resolvesApiAuthority(options, token)) return options;
  const resolvePermissions = options.resolvePermissions ?? (async () => {
    const current = callerSchema.parse(await api.request('/mcp/caller'));
    setCaller(current.id);
    return current;
  });
  const onToolCall = options.onToolCall ?? (event => api.request('/mcp/calls', 'POST', safeMcpToolEvent(event)).then(() => undefined));
  return { ...options, resolvePermissions, onToolCall };
}

export function createProjectMcpServer(apiBase = process.env.CANVAS_API_URL || defaultApi, fetcher: typeof fetch = fetch,
  options: ProjectMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'symbiknow', version: '0.2.0' }, { instructions });
  const token = apiToken();
  let callerId = options.callerId ?? 'local-stdio-agent';
  const actor = () => {
    const client = clientName(server);
    const name = agentName(client);
    return [name, options.actorSuffix].filter(Boolean).join(' - ').slice(0, 48);
  };
  const api = new CanvasApi(apiBase.replace(/\/$/, ''), fetcher, () => ({
    'x-symbiknow-actor': callerId, 'x-symbiknow-agent-name': actor(), 'x-symbiknow-agent-transport': 'mcp', ...tokenHeaders(options, token), ...options.headers,
  }));
  options = apiAuthorityOptions(api, options, token, id => { callerId = id; });
  const registration = scopedRegistration(server, options);
  const definitions = projectMcpTools(api, options.localFiles ?? true);
  for (const { name, config, handler } of definitions) registration.registerTool(name, config, handler as never);
  installScopedDiscovery(server, definitions, options);
  return server;
}

/** Connect a server and retain its lifecycle handle for embedded hosts. */
export async function connectProjectMcpServer(transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = createProjectMcpServer(undefined, undefined, { authoritativeApi: true });
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
