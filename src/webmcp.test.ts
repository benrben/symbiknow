// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import type { JsonSchema } from './webmcp-types';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { createApiServer } from '../server/index';

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

const opened: Array<{ server: Server; dataDir: string }> = [];
const toolNames = ['search_docs', 'open_doc', 'create_doc', 'upload_file', 'download_file', 'edit_doc', 'remove_doc', 'move_block', 'move_document',
  'list_versions', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision'];

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
  it('registers tools and runs create, read, search, edit, move, and remove against the HTTP API', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const { base, dataDir } = await startServer();
    const networkFetch = fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => networkFetch(new URL(url, base), init));

    const tools = new Map<string, ToolHandler>();
    const resources = new Map<string, ResourceHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void {
        super.registerTool(name, _description, _schema, handler);
        tools.set(name, handler);
      }
      registerResource(name: string, _description: string, _template: { uri: string; mimeType: string }, handler: ResourceHandler): void {
        super.registerResource(name, _description, _template, handler);
        resources.set(name, handler);
      }
    }
    vi.stubGlobal('window', { WebMCP: BrowserWebMCP });

    let changed = 0;
    const dispose = registerWebMCP(() => 'product-roadmap', () => { changed++; });
    await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));
    expect([...tools.keys()]).toEqual(toolNames);
    expect([...resources.keys()]).toEqual(['active_canvas']);

    const run = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool ${name} was not registered`);
      return JSON.parse((await handler(args)).content[0].text) as T;
    };

    const created = await run<CanvasBlock>('create_doc', {
      title: 'Research notes', content: '# Research\nUnique webmcp token', x: 123, y: -45,
    });
    expect(created).toMatchObject({ title: 'Research notes', kind: 'markdown', y: -45 });
    const nearby = ((await (await networkFetch(`${base}/api/canvases/product-roadmap`)).json()) as CanvasDocument).blocks.filter(block => block.id !== created.id);
    expect(nearby.every(block => created.x + created.width <= block.x || block.x + block.width <= created.x ||
      created.y + created.height <= block.y || block.y + block.height <= created.y)).toBe(true);
    expect(await readFile(path.join(dataDir, 'docs', `${created.id}.md`), 'utf8')).toContain('Unique webmcp token');
    expect(await run<CanvasBlock>('open_doc', { blockId: created.id })).toMatchObject({ id: created.id, content: created.content });
    expect(await run<CanvasBlock>('open_doc', { canvasId: 'product-roadmap', blockId: created.id })).toMatchObject({ id: created.id });
    const slides = await run<CanvasBlock>('create_doc', { title: 'Deck', kind: 'slides', content: '# Slide' });
    expect(slides.kind).toBe('slides');
    const html = await run<CanvasBlock>('create_doc', { title: 'Page', kind: 'html', content: '<!doctype html><h1>First</h1>' });
    expect(html).toMatchObject({ kind: 'markdown', content: expect.stringContaining('format: html') });
    const editedHtml = await run<CanvasBlock>('edit_doc', { blockId: html.id, kind: 'html', content: '<!doctype html><h1>Updated</h1>' });
    expect(editedHtml.content).toContain('<h1>Updated</h1>');
    const fallback = await run<CanvasBlock>('create_doc', { title: 'Untyped', kind: 'invalid' });
    expect(fallback).toMatchObject({ kind: 'markdown', content: '' });
    expect(await run<Array<{ blockId: string }>>('search_docs', { query: 'Unique webmcp token' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ blockId: created.id })]));

    const edited = await run<CanvasBlock>('edit_doc', { blockId: created.id, content: '# Revised\nUpdated by WebMCP' });
    expect(edited.content).toContain('Updated by WebMCP');
    const moved = await run<CanvasBlock>('move_block', { blockId: created.id, x: 900, y: 125 });
    expect(moved).toMatchObject({ x: 900, y: 125 });

    const resource = await resources.get('active_canvas')?.('canvas://active');
    expect(resource?.contents[0].uri).toBe('canvas://active');
    const canvas = JSON.parse(resource?.contents[0].text ?? '') as CanvasDocument;
    expect(canvas.blocks.find(block => block.id === created.id)).toMatchObject({ x: 900, content: edited.content });

    const replaced = await run<CanvasBlock & { overwritten: boolean }>('upload_file', { blockId: created.id,
      filename: 'research.html', content: '<!doctype html><h1>Whole file replacement</h1>' });
    expect(replaced).toMatchObject({ id: created.id, overwritten: true });
    expect(replaced.content).toContain('format: html');
    expect((await run<{ content: string }>('download_file', { blockId: created.id })).content).toBe(replaced.content);

    expect(await run<{ ok: boolean }>('remove_doc', { blockId: created.id })).toEqual({ ok: true });
    expect(await run<{ ok: boolean }>('remove_doc', { blockId: slides.id })).toEqual({ ok: true });
    expect(await run<{ ok: boolean }>('remove_doc', { blockId: html.id })).toEqual({ ok: true });
    expect(await run<{ ok: boolean }>('remove_doc', { blockId: fallback.id })).toEqual({ ok: true });
    await expect(readFile(path.join(dataDir, 'docs', `${created.id}.md`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changed).toBe(12);
    for (const name of ['analyze_canvas', 'score_documents', 'merge_documents', 'run_workspace_automation', 'undo_jev_run']) {
      expect(tools.has(name)).toBe(false);
    }
    dispose();
  }, 20_000);

  it('rejects invalid requests before writing to the canvas', async () => {
    vi.resetModules();
    const { registerWebMCP } = await import('./webmcp');
    const { base } = await startServer();
    const networkFetch = fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => networkFetch(new URL(url, base), init));

    const tools = new Map<string, ToolHandler>();
    class BrowserWebMCP extends (await nativeConstructor()) {
      registerTool(name: string, _description: string, _schema: JsonSchema, handler: ToolHandler): void { super.registerTool(name, _description, _schema, handler); tools.set(name, handler); }
      registerResource(name: string, description: string, template: { uri: string; mimeType: string }, handler: ResourceHandler): void { super.registerResource(name, description, template, handler); }
    }
    vi.stubGlobal('window', { WebMCP: BrowserWebMCP });
    let changed = 0;
    registerWebMCP(() => 'product-roadmap', () => { changed++; });
    await vi.waitFor(() => expect(tools.size).toBe(toolNames.length));

    await expect(tools.get('create_doc')?.({ content: '# Untitled' })).rejects.toThrow('title is required.');
    await expect(tools.get('open_doc')?.({ blockId: 'missing' })).rejects.toThrow('Document not found.');
    await expect(tools.get('edit_doc')?.({ blockId: 'launch-checklist' })).rejects.toThrow('Provide a title, content, or kind to edit.');
    await expect(tools.get('move_block')?.({ blockId: 'launch-checklist', x: Number.POSITIVE_INFINITY, y: 0 }))
      .rejects.toThrow('x and y must be finite numbers.');
    await expect(tools.get('move_block')?.({ blockId: 'launch-checklist', x: 0, y: Number.NaN }))
      .rejects.toThrow('x and y must be finite numbers.');
    await expect(tools.get('search_docs')?.({ query: ' ' })).rejects.toThrow('query is required.');
    expect(changed).toBe(0);
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
    await expect(tools.get('open_doc')?.({ blockId: 'roadmap-overview' })).rejects.toThrow('Open a canvas');
    await expect(tools.get('open_doc')?.({ canvasId: ' ', blockId: 'roadmap-overview' })).rejects.toThrow('Open a canvas');
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
