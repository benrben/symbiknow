// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import type { JsonSchema } from './webmcp-types';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { createApiServer } from '../server/index';
import { advertisedTool, projectMcpDefinitions } from '../server/mcp-registry';
import { localBrowserUpload } from './webmcp-files.test.fixture';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type ResourceHandler = (uri: string) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;

const nativeInstances: Array<{ inactivityTimer: number }> = [];

async function nativeConstructor() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const source = await readFile('node_modules/@jason.today/webmcp/src/webmcp.js', 'utf8');
  const adapter = await readFile('public/webmcp-adapter.js', 'utf8');
  const Native = runInNewContext(source + '\n' + adapter + '\nWebMCP;', {
    window, document, sessionStorage, console, Promise,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
  }) as NonNullable<Window['WebMCP']>;
  return class extends Native {
    constructor(options?: Record<string, unknown>) {
      super(options);
      nativeInstances.push(this as unknown as { inactivityTimer: number });
    }
  };
}

const nativeNetworkFetch = globalThis.fetch;
const opened: Array<{ server: Server; dataDir: string }> = [];
const catalog = projectMcpDefinitions().map(advertisedTool);
const toolNames = catalog.map(tool => tool.name);
beforeEach(() => { vi.stubGlobal('fetch', async () => Response.json({ tools: catalog })); });

async function startServer(): Promise<{ base: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-webmcp-'));
  const server = await createApiServer({ dataDir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, dataDir });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { base: `http://127.0.0.1:${address.port}`, dataDir };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const widget of nativeInstances.splice(0)) window.clearTimeout(widget.inactivityTimer);
  document.body.replaceChildren();
  sessionStorage.clear();
  delete window.WebMCP;
  vi.restoreAllMocks();
  for (const item of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close(error => error ? reject(error) : resolve()));
    await rm(item.dataDir, { recursive: true, force: true });
  }
});

describe('WebMCP document tools', () => {
  async function registered() {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const { base, dataDir } = await startServer();
    const networkFetch = nativeNetworkFetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => networkFetch(new URL(url, base), init));
    const tools = new Map<string, ToolHandler>();
    const resources = new Map<string, ResourceHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, description: string, schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, description, schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); resources.set(name, handler); }
    }
    vi.stubGlobal('window', { WebMCP: BrowserWebMCP });
    const changed = vi.fn();
    const dispose = registerWebMCP(() => 'product-roadmap', changed);
    await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
    const run = async <T>(name: string, args: Record<string, unknown>): Promise<T> => JSON.parse((await tools.get(name)!(args)).content[0].text) as T;
    return { run, tools, resources, dataDir, changed, dispose };
  }

  it('advertises the canonical catalog and runs file edits, reads, search, move and checked deletion through MCP', async () => {
    const app = await registered();
    expect([...app.tools.keys()]).toEqual(toolNames);
    for (const old of ['create_doc', 'edit_doc', 'open_doc', 'remove_doc']) expect(app.tools.has(old)).toBe(false);
    expect(app.tools.has('ask_symbi')).toBe(true);
    const created = await localBrowserUpload(app.run, app.dataDir, { title: 'Research notes', filename: 'research.mdx', kind: 'mdx', content: '# Research\nUnique webmcp token' });
    expect(created).toMatchObject({ title: 'Research notes', kind: 'mdx' });
    expect(await readFile(path.join(app.dataDir, created.file), 'utf8')).toContain('Unique webmcp token');
    const matches = await app.run<Array<{ blockId: string }>>('search_docs', { query: 'Unique webmcp token' });
    expect(matches).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: created.id })]));
    const edited = await localBrowserUpload(app.run, app.dataDir, { blockId: created.id, content: '# Revised\nUpdated through local files' });
    expect(await app.run<CanvasBlock>('read_doc', { blockId: created.id })).toMatchObject({ content: edited.content });
    expect(await app.run('move_block', { blockId: created.id, x: 900, y: 125 })).toMatchObject({ blockId: created.id, x: 900, y: 125 });
    const resource = await app.resources.get('active_canvas')!('canvas://active');
    const canvas = JSON.parse(resource.contents[0].text) as CanvasDocument;
    expect(canvas.blocks.find(block => block.id === created.id)).toMatchObject({ x: 900, content: edited.content });
    await app.run('delete_doc', { blockId: created.id, expectedContentHash: edited.contentHash });
    await expect(readFile(path.join(app.dataDir, created.file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(app.changed).toHaveBeenCalledTimes(4);
    app.dispose();
  });

  it('keeps server validation authoritative and does not notify writes after a failed call', async () => {
    const app = await registered();
    await expect(app.run('upload_file', { filename: 'notes.md', content: '# Incomplete upload' })).rejects.toThrow();
    await expect(app.run('read_doc', { blockId: 'missing' })).rejects.toThrow();
    await expect(app.run('delete_doc', { blockId: 'launch-checklist' })).rejects.toThrow();
    await expect(app.run('move_block', { blockId: 'launch-checklist', x: Number.NaN, y: 0 })).rejects.toThrow();
    expect(app.changed).not.toHaveBeenCalled();
    app.dispose();
  });

  it('retries a failed package script load and then installs the adapter', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const tools = new Map<string, ToolHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, _description, _schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', {});
    const scripts: string[] = [];
    vi.stubGlobal('document', {
      createElement: () => ({ src: '', async: false, onload: () => {}, onerror: () => {} }),
      head: {
        appendChild(script: { src: string; onload: () => void; onerror: () => void }) {
          scripts.push(script.src);
          queueMicrotask(() => {
            if (scripts.length === 1) return script.onerror();
            if (script.src === '/webmcp-adapter.js') Object.assign(window, { WebMCP: BrowserWebMCP });
            script.onload();
          });
        },
      },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerWebMCP(() => 'product-roadmap', () => {});
      await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
      registerWebMCP(() => 'product-roadmap', () => {});
      await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
      expect(scripts).toHaveLength(3);
      expect(scripts[1]).toBe(scripts[0]);
      expect(scripts[2]).toBe('/webmcp-adapter.js');
    } finally {
      warning.mockRestore();
    }
  });

  it('requires an active canvas when a tool omits canvasId', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const tools = new Map<string, ToolHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, _description, _schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', { WebMCP: BrowserWebMCP });
    registerWebMCP(() => '', () => {});
    await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
    await expect(tools.get('read_doc')?.({ blockId: 'roadmap-overview' })).rejects.toThrow('Open a canvas');
  });

  it('retries adapter initialization without reloading the upstream package', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const tools = new Map<string, ToolHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, _description, _schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', {});
    const scripts: string[] = [];
    vi.stubGlobal('document', {
      createElement: () => ({ src: '', async: false, onload: () => {}, onerror: () => {} }),
      head: {
        appendChild(script: { src: string; onload: () => void }) {
          scripts.push(script.src);
          queueMicrotask(() => {
            if (scripts.length === 3) Object.assign(window, { WebMCP: BrowserWebMCP });
            script.onload();
          });
        },
      },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerWebMCP(() => 'product-roadmap', () => {});
      await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
      registerWebMCP(() => 'product-roadmap', () => {});
      await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
      expect(scripts).toHaveLength(3);
      expect(scripts[1]).toBe('/webmcp-adapter.js');
      expect(scripts[2]).toBe('/webmcp-adapter.js');
    } finally {
      warning.mockRestore();
    }
  });

  it('does not mount a widget or warn after the caller disposes registration', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    vi.stubGlobal('window', {});
    let rejectScript: (() => void) | undefined;
    vi.stubGlobal('document', {
      createElement: () => ({ src: '', async: false, onload: () => {}, onerror: () => {} }),
      head: { appendChild(script: { onerror: () => void }) { rejectScript = script.onerror; } },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dispose = registerWebMCP(() => 'product-roadmap', () => {});
      dispose();
      rejectScript?.();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('shares a pending script load and registers one widget for concurrent callers', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const tools = new Map<string, ToolHandler>();
    let constructions = 0;
    class BrowserWebMCP extends (await nativeConstructor()) {
      constructor() { super(); constructions++; }
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, _description, _schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', {});
    const scripts: Array<{ src: string; onload: () => void }> = [];
    vi.stubGlobal('document', {
      createElement: () => ({ src: '', async: false, onload: () => {}, onerror: () => {} }),
      head: { appendChild(script: { src: string; onload: () => void }) { scripts.push(script); } },
    });
    const dispose = registerWebMCP(() => 'product-roadmap', () => {});
    registerWebMCP(() => 'product-roadmap', () => {});
    expect(scripts).toHaveLength(1);
    dispose();
    scripts[0].onload();
    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    Object.assign(window, { WebMCP: BrowserWebMCP });
    scripts[1].onload();
    await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
    expect(constructions).toBe(1);
  });

  it('keeps the existing widget when registration runs again after setup', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    let constructions = 0;
    let registrations = 0;
    class BrowserWebMCP extends (await nativeConstructor()) {
      constructor() { super(); constructions++; }
      registerTool(name: string, description: string, schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, description, schema, handler); registrations++; }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', { WebMCP: BrowserWebMCP });
    registerWebMCP(() => 'product-roadmap', () => {});
    await vi.waitFor(() => expect(registrations).toBe(toolNames.length));
    registerWebMCP(() => 'product-roadmap', () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(constructions).toBe(1);
    expect(registrations).toBe(toolNames.length);
  });

  it('does not register when a host page removes the WebMCP constructor before setup', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const Native = await nativeConstructor();
    let reads = 0;
    const host: Record<string, unknown> = {};
    Object.defineProperty(host, 'WebMCP', { get: () => ++reads === 1 ? Native : undefined });
    vi.stubGlobal('window', host);
    registerWebMCP(() => 'product-roadmap', () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBeGreaterThan(1);
  });
});
