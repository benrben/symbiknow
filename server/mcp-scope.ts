import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { advertisedTool, projectMcpMetadata, toolPermission, type McpPermission, type McpToolConfig, type McpToolDefinition } from './mcp-registry.js';
import type { McpPermissions, ProjectMcpOptions } from './mcp-options.js';
import { ApiRequestError } from './mcp-api.js';
import { withinMcpCall } from './mcp-call-context.js';

type Access = NonNullable<ProjectMcpOptions['access']>;
type ToolHandler = (...args: unknown[]) => unknown;
const filterFailure = 'Could not safely filter scoped tool results.';
const accessByPermission: Record<McpPermission, Access[]> = {
  read: ['read', 'propose', 'write'], propose: ['propose', 'write'], write: ['write'], approve: ['write'], configure: ['write'],
};
function explicitGrant(permissions: McpPermissions, permission: McpPermission): boolean {
  if (permission === 'approve') return permissions.canApprove === true;
  if (permission === 'configure') return permissions.canConfigure === true;
  return true;
}
function permits(permissions: McpPermissions, name: string, permission: McpPermission): boolean {
  if (permissions.tools && !permissions.tools.includes(name)) return false;
  const access = permissions.access ?? 'write';
  return accessByPermission[permission].includes(access) && explicitGrant(permissions, permission);
}
export function canCallMcpTool(access: Access, name: string, tools?: string[], grants: Pick<McpPermissions, 'canApprove' | 'canConfigure'> = {}): boolean {
  const permission = projectMcpMetadata().find(tool => tool.name === name)?.permission;
  if (!permission) return false;
  return permits({ access, tools, ...grants }, name, permission);
}
async function currentPermissions(options: ProjectMcpOptions): Promise<McpPermissions> {
  const permissions = options.resolvePermissions ? await options.resolvePermissions() : options;
  if (!permissions) throw new Error('The MCP caller authorization was revoked.');
  return permissions;
}
function textContent(value: unknown) {
  const content = (value as { content?: Array<{ type?: string; text?: string }> })?.content;
  const first = content?.[0];
  if (!first || typeof first.text !== 'string') throw new Error(filterFailure);
  return { first, content: content! };
}
function parsedResults(text: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(filterFailure); }
  if (!Array.isArray(parsed)) throw new Error(filterFailure);
  return parsed;
}
function parsedSearch(text: string): { hits: unknown[]; page?: Record<string, unknown> } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(filterFailure); }
  if (Array.isArray(parsed)) return { hits: parsed };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return { hits: (parsed as { items: unknown[] }).items, page: parsed as Record<string, unknown> };
  }
  throw new Error(filterFailure);
}
function allowedHit(hit: unknown, allowed: Set<string>) {
  return hit && typeof hit === 'object' && allowed.has((hit as { canvasId?: string }).canvasId ?? '');
}
function scopedWorkspace(workspace: unknown, allowed: Set<string>) {
  if (!workspace || typeof workspace !== 'object' || !Array.isArray((workspace as { canvases?: unknown }).canvases)) {
    throw new Error(filterFailure);
  }
  return { ...workspace, canvases: (workspace as { canvases: Array<{ id?: string }> }).canvases.filter(canvas => allowed.has(canvas.id ?? '')) };
}
export function scopedResult(name: string, value: unknown, allowed: Set<string>): unknown {
  if (name !== 'list_canvases' && name !== 'search_docs') return value;
  const { first, content } = textContent(value);
  if (name === 'search_docs') {
    const { hits, page } = parsedSearch(first.text!);
    const filtered = hits.filter(hit => allowedHit(hit, allowed));
    return { ...value as Record<string, unknown>, content: [{ ...first,
      text: JSON.stringify(page ? { ...page, items: filtered } : filtered) }, ...content.slice(1)] };
  }
  const parsed = parsedResults(first.text!);
  const filtered = parsed.map(workspace => scopedWorkspace(workspace, allowed)).filter(workspace => workspace.canvases.length);
  return { ...value as Record<string, unknown>, content: [{ ...first, text: JSON.stringify(filtered) }, ...content.slice(1)] };
}
export function mcpCanvasIds(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input)) return input.flatMap(mcpCanvasIds);
  return Object.entries(input).flatMap(canvasEntry);
}
function canvasArray(key: string, value: unknown[]): string[] {
  const strings = value.filter((id): id is string => typeof id === 'string');
  if (key === 'sourceIds') return strings.filter(id => id.includes(':')).map(id => id.split(':')[0]);
  if (/^(?:canvasIds|targetCanvasIds|sourceCanvasIds)$/.test(key)) return strings;
  return value.flatMap(mcpCanvasIds);
}
function canvasEntry([key, value]: [string, unknown]): string[] {
  if (/^(?:canvasId|sourceCanvasId|targetCanvasId)$/.test(key) && typeof value === 'string') return [value];
  if (Array.isArray(value)) return canvasArray(key, value);
  return mcpCanvasIds(value);
}
function toolDenied(name: string, input: Record<string, unknown> | undefined, permissions: McpPermissions) {
  if (!permissions.allowedCanvasIds) return false;
  const allowed = new Set(permissions.allowedCanvasIds);
  const direct = mcpCanvasIds(input);
  const directDenied = direct.some(id => !allowed.has(id));
  const missingScope = !['list_canvases', 'search_docs', 'ask_symbi', 'symbi_reflex'].includes(name) && !direct.length;
  return directDenied || missingScope;
}
function publisher(options: ProjectMcpOptions, name: string, args: unknown[], startedAt: string) {
  return async (outcome: 'success' | 'error' | 'denied', value?: unknown) => {
    try { await options.onToolCall?.({ tool: name, args: args[0], startedAt, endedAt: new Date().toISOString(), outcome, result: value }); }
    catch { console.error('MCP activity ledger could not record a tool call'); }
  };
}
function conflictToolResult(error: unknown) {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return undefined;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message,
    code: 'conflict', currentContentHash: error.currentContentHash,
    instruction: 'Download the current file and merge in your environment before retrying; keep your edited working copy.' }) }] };
}
function requireToolPermission(name: string, config: McpToolConfig, input: Record<string, unknown> | undefined, permissions: McpPermissions) {
  if (!permits(permissions, name, toolPermission(config)) || toolDenied(name, input, permissions)) {
    throw new Error('This caller scope does not permit that tool, operation, or canvas.');
  }
  if (name === 'upload_file' && permissions.access === 'propose' && input?.mode !== 'propose') {
    throw new Error('This caller scope does not permit that tool, operation, or canvas.');
  }
}
function scopeToolValue(name: string, value: unknown, permissions: McpPermissions) {
  return permissions.allowedCanvasIds ? scopedResult(name, value, new Set(permissions.allowedCanvasIds)) : value;
}
function toolOutcome(value: unknown): 'error' | 'success' {
  return (value as { isError?: boolean })?.isError ? 'error' : 'success';
}
function safeToolHandler(name: string, handler: ToolHandler, config: McpToolConfig, options: ProjectMcpOptions): ToolHandler {
  return async (...args: unknown[]) => {
    const startedAt = new Date().toISOString();
    const publish = publisher(options, name, args, startedAt);
    let denied = true;
    try {
      const permissions = await currentPermissions(options);
      const input = args[0] as Record<string, unknown> | undefined;
      requireToolPermission(name, config, input, permissions);
      denied = false;
      const raw = await withinMcpCall(args.at(-1), name, async () => handler(...args));
      const value = scopeToolValue(name, raw, permissions);
      await publish(toolOutcome(value), value);
      return value;
    } catch (error) {
      await publish(denied ? 'denied' : 'error');
      const conflict = conflictToolResult(error);
      if (conflict) return conflict;
      throw error;
    }
  };
}
/** All tools are registered once; execution always resolves the current grants. */
export function scopedRegistration(server: McpServer, options: ProjectMcpOptions): McpServer {
  const definitions: McpToolDefinition[] = [];
  return new Proxy(server, { get(target, property, receiver) {
    if (property !== 'registerTool') return Reflect.get(target, property, receiver);
    return (name: string, config: McpToolConfig, handler: ToolHandler) => {
      const registered = Reflect.apply(target.registerTool, target, [name, config, safeToolHandler(name, handler, config, options)]);
      definitions.push({ name, config, handler });
      if (definitions.length === 1) installScopedDiscovery(target, definitions, options);
      return registered;
    };
  } }) as McpServer;
}
/** Discovery uses the same definitions and fresh grants as execution. */
export function installScopedDiscovery(server: McpServer, definitions: McpToolDefinition[], options: ProjectMcpOptions): void {
  const advertised = new Map<string, ReturnType<typeof advertisedTool>>();
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const permissions = await currentPermissions(options);
    return { tools: definitions.filter(definition => permits(permissions, definition.name, toolPermission(definition.config))).map(definition => {
      if (!advertised.has(definition.name)) advertised.set(definition.name, advertisedTool(definition));
      return advertised.get(definition.name)!;
    }) };
  });
}
