import { api } from './api';
import { activeCanvas, changed, hasRegistrations, registerContext } from './webmcp-context';
import { loadScript } from './webmcp-loader';
import type { CanonicalTool, ToolResult, WebMCPInstance } from './webmcp-types';

let instance: WebMCPInstance | null = null;
let installation: Promise<void> | null = null;

function toolArguments(tool: CanonicalTool, args: Record<string, unknown>): Record<string, unknown> {
  const input = { ...args };
  if (tool.inputSchema.required?.includes('canvasId') && input.canvasId === undefined) {
    input.canvasId = activeCanvas();
    if (!input.canvasId) throw new Error('Open a canvas before using this tool, or provide canvasId.');
  }
  return input;
}
async function execute(tool: CanonicalTool, args: Record<string, unknown>): Promise<ToolResult> {
  const input = toolArguments(tool, args);
  const result = await api<ToolResult>('/mcp/browser', { method: 'POST', body: JSON.stringify({ name: tool.name, arguments: input }) });
  if (result.isError) {
    const message = result.content.filter(part => part.type === 'text').map(part => String(part.text)).join('\n');
    throw new Error(message || 'The MCP tool failed.');
  }
  if (tool.annotations?.readOnlyHint !== true && tool._meta?.permission !== 'read') changed();
  return result;
}

async function install(): Promise<void> {
  const catalog = await api<{ tools: CanonicalTool[] }>('/mcp/browser');
  if (!hasRegistrations() || !window.WebMCP || instance) return;
  const mcp = new window.WebMCP({ color: '#bce7c9', position: 'bottom-left', size: '28px', padding: '18px' });
  for (const tool of catalog.tools) registerCatalogTool(mcp, tool);
  const readCanvas = catalog.tools.find(tool => tool.name === 'read_canvas');
  if (readCanvas) mcp.registerResource('active_canvas', 'Current canvas layout and saved document sources.', {
    uri: 'canvas://active', mimeType: 'application/json',
  }, async uri => {
    const result = await execute(readCanvas, {});
    const text = result.structuredContent ? JSON.stringify(result.structuredContent)
      : result.content.filter(part => part.type === 'text').map(part => String(part.text)).join('\n');
    return { contents: [{ uri, mimeType: 'application/json', text }] };
  });
  instance = mcp;
}
function registerCatalogTool(mcp: WebMCPInstance, tool: CanonicalTool): void {
  const schema = { ...tool.inputSchema, required: tool.inputSchema.required?.filter(field => field !== 'canvasId') };
  mcp.registerTool(tool.name, tool.description ?? tool.name, schema, args => execute(tool, args));
}

/** The browser advertises and invokes the canonical server MCP catalog. */
export function registerWebMCP(getActiveCanvasId: () => string, onChanged: () => void) {
  const releaseContext = registerContext(getActiveCanvasId, onChanged);
  let active = true;
  void loadScript().then(async () => {
    if (!active || !window.WebMCP || instance) return;
    installation ??= install().finally(() => { installation = null; });
    await installation;
  }).catch(error => { if (active) console.warn('WebMCP unavailable:', error); });
  return () => { active = false; releaseContext(); };
}
