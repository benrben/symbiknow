import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readableMcpTools } from './settings.js';
import type { ProjectMcpOptions } from './mcp-options.js';
import { ApiRequestError } from './mcp-api.js';

type Access = NonNullable<ProjectMcpOptions['access']>;
type ToolHandler = (...args: unknown[]) => unknown;
const filterFailure = 'Could not safely filter scoped tool results.';
export function canCallMcpTool(access: Access, name: string, tools?: string[]): boolean {
  return (!tools || tools.includes(name))
    && (access === 'write' || readableMcpTools.has(name) || (access === 'propose' && name === 'jev_propose'));
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
function directCanvasIds(input: Record<string, unknown> | undefined) {
  return [input?.canvasId, input?.sourceCanvasId, input?.targetCanvasId].filter((id): id is string => typeof id === 'string');
}
function toolDenied(name: string, input: Record<string, unknown> | undefined, options: ProjectMcpOptions) {
  if (!options.allowedCanvasIds) return false;
  const allowed = new Set(options.allowedCanvasIds);
  const direct = directCanvasIds(input);
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
    instruction: 'Read the current source and merge before retrying.' }) }] };
}
function safeToolHandler(name: string, handler: ToolHandler, options: ProjectMcpOptions): ToolHandler {
  return async (...args: unknown[]) => {
    const startedAt = new Date().toISOString();
    const publish = publisher(options, name, args, startedAt);
    let denied = false;
    try {
      denied = toolDenied(name, args[0] as Record<string, unknown> | undefined, options);
      if (denied) throw new Error('This token scope does not permit that tool or canvas.');
      const raw = await handler(...args);
      const value = options.allowedCanvasIds ? scopedResult(name, raw, new Set(options.allowedCanvasIds)) : raw;
      await publish('success', value);
      return value;
    } catch (error) {
      await publish(denied ? 'denied' : 'error');
      const conflict = conflictToolResult(error);
      if (conflict) return conflict;
      throw error;
    }
  };
}
/** Register only tools the remote token can use and check canvas scope at execution time. */
export function scopedRegistration(server: McpServer, options: ProjectMcpOptions): McpServer {
  const { access = 'write', tools } = options;
  return new Proxy(server, { get(target, property, receiver) {
    if (property !== 'registerTool') return Reflect.get(target, property, receiver);
    return (name: string, config: unknown, handler: ToolHandler) => {
      if (!canCallMcpTool(access, name, tools)) return undefined;
      return Reflect.apply(target.registerTool, target, [name, config, safeToolHandler(name, handler, options)]);
    };
  } }) as McpServer;
}
