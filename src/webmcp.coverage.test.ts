import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalTool, JsonSchema, ToolResult } from './webmcp-types';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type ResourceHandler = (uri: string) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
type BrowserCall = { name: string; arguments: Record<string, unknown> };

const objectSchema = (required: string[] = []): JsonSchema => ({ type: 'object', properties: {}, required });

/** Records what the page widget advertises; the real module still calls the canonical browser endpoint. */
function browserWidget() {
  const tools = new Map<string, { description: string; schema: JsonSchema; handler: ToolHandler }>();
  const resources = new Map<string, ResourceHandler>();
  let constructions = 0;
  class RecordingWebMCP {
    constructor() { constructions++; }
    registerTool(name: string, description: string, schema: JsonSchema, handler: ToolHandler) { tools.set(name, { description, schema, handler }); }
    registerResource(name: string, _description: string, _template: { uri: string; mimeType: string }, handler: ResourceHandler) { resources.set(name, handler); }
  }
  return { RecordingWebMCP, tools, resources, constructions: () => constructions };
}

function browserServer(catalog: CanonicalTool[], results: Record<string, ToolResult>, catalogReady: Promise<void> = Promise.resolve()) {
  const calls: BrowserCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    expect(url).toBe('/api/mcp/browser');
    if (init.method !== 'POST') { await catalogReady; return Response.json({ tools: catalog }); }
    const call = JSON.parse(String(init.body)) as BrowserCall;
    calls.push(call);
    return Response.json(results[call.name]);
  });
  return calls;
}

async function registeredWidget(catalog: CanonicalTool[], results: Record<string, ToolResult>) {
  vi.resetModules();
  const { registerWebMCP } = await import('./webmcp');
  const widget = browserWidget();
  vi.stubGlobal('window', { WebMCP: widget.RecordingWebMCP });
  const calls = browserServer(catalog, results);
  const changed = vi.fn();
  const dispose = registerWebMCP(() => 'product-roadmap', changed);
  await vi.waitFor(() => expect(widget.tools.size).toBe(catalog.length));
  return { ...widget, calls, changed, dispose };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('WebMCP catalog adapter', () => {
  it('names undescribed tools, omits the canvas resource without read_canvas, and reports a failure without text', async () => {
    const audit: CanonicalTool = { name: 'audit_canvas', inputSchema: objectSchema(['canvasId', 'scope']) };
    const app = await registeredWidget([audit], {
      audit_canvas: { isError: true, content: [{ type: 'image', data: 'chart', mimeType: 'image/png' }] },
    });
    expect(app.tools.get('audit_canvas')).toMatchObject({ description: 'audit_canvas', schema: { required: ['scope'] } });
    expect(app.resources.size).toBe(0);
    await expect(app.tools.get('audit_canvas')!.handler({ scope: 'all' })).rejects.toThrow('The MCP tool failed.');
    expect(app.calls).toEqual([{ name: 'audit_canvas', arguments: { scope: 'all', canvasId: 'product-roadmap' } }]);
    expect(app.changed).not.toHaveBeenCalled();
    app.dispose();
  });

  it('serves structured canvas content and notifies only for tools that may write', async () => {
    const readCanvas: CanonicalTool = { name: 'read_canvas', description: 'Read a canvas', inputSchema: objectSchema(['canvasId']), annotations: { readOnlyHint: true } };
    const readDoc: CanonicalTool = { name: 'read_doc', description: 'Read a document', inputSchema: objectSchema(['canvasId']), _meta: { permission: 'read' } };
    const moveBlock: CanonicalTool = { name: 'move_block', description: 'Move a document', inputSchema: objectSchema(['canvasId']) };
    const layout = { id: 'product-roadmap', blocks: [{ id: 'launch-checklist', x: 120 }] };
    const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
    const app = await registeredWidget([readCanvas, readDoc, moveBlock], {
      read_canvas: { ...ok('{"ignored":true}'), structuredContent: layout }, read_doc: ok('{}'), move_block: ok('{}'),
    });
    const resource = await app.resources.get('active_canvas')!('canvas://active');
    expect(resource.contents).toEqual([{ uri: 'canvas://active', mimeType: 'application/json', text: JSON.stringify(layout) }]);
    await app.tools.get('read_doc')!.handler({ blockId: 'launch-checklist' });
    expect(app.changed).not.toHaveBeenCalled();
    await app.tools.get('move_block')!.handler({ blockId: 'launch-checklist', canvasId: 'other-canvas' });
    expect(app.changed).toHaveBeenCalledTimes(1);
    expect(app.calls.at(-1)).toEqual({ name: 'move_block', arguments: { blockId: 'launch-checklist', canvasId: 'other-canvas' } });
    app.dispose();
  });

  it('does not mount a widget when the last consumer leaves while the catalog is loading', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const widget = browserWidget();
    vi.stubGlobal('window', { WebMCP: widget.RecordingWebMCP });
    let releaseCatalog = () => {};
    const catalogReady = new Promise<void>(resolve => { releaseCatalog = resolve; });
    const catalogRequested = vi.fn();
    browserServer([{ name: 'read_canvas', inputSchema: objectSchema() }], {}, catalogReady.then(catalogRequested));
    const dispose = registerWebMCP(() => 'product-roadmap', () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    dispose();
    releaseCatalog();
    await vi.waitFor(() => expect(catalogRequested).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(widget.constructions()).toBe(0);
    expect(widget.tools.size).toBe(0);
  });
});
