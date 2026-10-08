// @vitest-environment jsdom
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApiServer } from '../server/index';
import type { CanvasStore } from '../server/storage';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { expectRestoredCanvas } from '../server/tests/restoration';
import { localBrowserUpload } from './webmcp-files.test.fixture';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type DocumentHistory = Awaited<ReturnType<CanvasStore['documentHistory']>>;
type NativeMCP = {
  availableTools: Map<string, { execute: (args: Record<string, unknown>) => Promise<ToolResult>; inputSchema: unknown }>;
  availableResources: Map<string, { provide: (uri: string) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> }>;
  inactivityTimer: number;
};
const opened: Array<{ server: Server; directory: string }> = [];
const transports: Server[] = [];
const widgets: NativeMCP[] = [];
const networkFetch = globalThis.fetch;

async function nativeLibrary() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const library = await readFile('node_modules/@jason.today/webmcp/src/webmcp.js', 'utf8');
  const adapter = await readFile('public/webmcp-adapter.js', 'utf8');
  window.eval(`${library}\n${adapter}`);
  const Native = window.WebMCP!;
  class ObservedWebMCP extends Native {
    constructor(options?: Record<string, unknown>) {
      super(options);
      widgets.push(this as unknown as NativeMCP);
    }
  }
  window.WebMCP = ObservedWebMCP;
}

async function fixture() {
  vi.resetModules();
  await nativeLibrary();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'allteam-webmcp-native-'));
  let server = await createApiServer({ dataDir: directory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const instance = { server, directory };
  opened.push(instance);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  let base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => networkFetch(new URL(url, base), init));
  const { registerWebMCP } = await import('./webmcp');
  const onChanged = vi.fn();
  const dispose = registerWebMCP(() => 'product-roadmap', onChanged);
  await vi.waitFor(() => expect(widgets[0]?.availableTools.has('download_file')).toBe(true));
  const widget = widgets[0];
  async function run<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const tool = widget.availableTools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return JSON.parse((await tool.execute(args)).content[0].text) as T;
  }
  async function read(route: string): Promise<CanvasDocument> {
    return networkFetch(base + '/api' + route).then(response => response.json()) as Promise<CanvasDocument>;
  }
  async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await networkFetch(base + '/api' + route, { method,
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  }
  async function restart(): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = await createApiServer({ dataDir: directory });
    instance.server = server;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing restarted server address');
    base = `http://127.0.0.1:${address.port}`;
  }
  const upload = (args: Record<string, unknown>) => localBrowserUpload(run, directory, args);
  return { run, upload, read, request, restart, base, directory, dispose, widget, onChanged, registerWebMCP };
}

afterEach(async () => {
  for (const widget of widgets.splice(0)) window.clearTimeout(widget.inactivityTimer);
  for (const server of transports.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const { server, directory } of opened.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
  delete window.WebMCP;
  document.body.replaceChildren();
  document.head.querySelectorAll('script').forEach(script => script.remove());
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('restores the preceding live registration when the newest consumer disposes', async () => {
  const app = await fixture();
  const inactive = vi.fn();
  const disposeLatest = app.registerWebMCP(() => 'no-longer-active', inactive);
  await Promise.resolve();
  disposeLatest();
  const created = await app.upload({ title: 'Live registration', content: 'Saved by the remaining consumer.' });
  expect((await app.read('/canvases/product-roadmap')).blocks.some(block => block.id === created.id)).toBe(true);
  expect(app.onChanged).toHaveBeenCalledOnce();
  expect(inactive).not.toHaveBeenCalled();
});

it('does not expose task tools through browser WebMCP', async () => {
  const app = await fixture();
  expect([...app.widget.availableTools.keys()].filter(name => name.includes('task'))).toEqual([]);
});

it('drops the disposed active-canvas fallback and callback while keeping explicit-canvas tools available', async () => {
  const app = await fixture();
  app.dispose();
  await expect(app.run('read_doc', { blockId: 'roadmap-overview' })).rejects.toThrow('Open a canvas');
  const created = await app.upload({ canvasId: 'product-roadmap', title: 'Explicit destination', content: 'Complete source' });
  expect((await app.read('/canvases/product-roadmap')).blocks.some(block => block.id === created.id)).toBe(true);
  expect(app.onChanged).not.toHaveBeenCalled();
});

it('keeps the newest live consumer when an intermediate registration disposes, then returns to its predecessor', async () => {
  const app = await fixture();
  const middleChanged = vi.fn();
  const latestChanged = vi.fn();
  const disposeMiddle = app.registerWebMCP(() => 'inactive-middle', middleChanged);
  const disposeLatest = app.registerWebMCP(() => 'product-roadmap', latestChanged);
  await Promise.resolve();
  disposeMiddle();
  disposeMiddle();
  await app.upload({ title: 'Newest consumer', content: '# First write' });
  expect(latestChanged).toHaveBeenCalledOnce();
  expect(app.onChanged).not.toHaveBeenCalled();
  disposeLatest();
  await app.upload({ title: 'Original consumer', content: '# Second write' });
  expect(app.onChanged).toHaveBeenCalledOnce();
  expect(middleChanged).not.toHaveBeenCalled();
  expect(widgets).toHaveLength(1);
});

it('returns API write failures without notifying consumers or changing another canvas', async () => {
  const app = await fixture();
  const before = await app.read('/canvases/product-roadmap');
  await expect(app.upload({ canvasId: 'missing', title: 'Rejected write', content: '# Complete source' })).rejects.toThrow('Canvas not found');
  await expect(app.upload({ blockId: 'missing', content: '# Replacement' })).rejects.toThrow();
  expectRestoredCanvas(await app.read('/canvases/product-roadmap'), before);
  expect(app.onChanged).not.toHaveBeenCalled();
});

it('runs the complete version lifecycle through native registered tools and reads each saved source back', async () => {
  const app = await fixture();
  const created = await app.upload({ title: 'Versioned source', content: '# Baseline' });
  const args = { blockId: created.id };
  const versions = await app.run<{ commits: Array<{ id: string }> }>('list_versions', args);
  expect(versions.commits.length).toBeGreaterThan(0);
  await app.run('create_branch', { ...args, name: 'feature/native-adapter' });
  expect(app.onChanged).toHaveBeenCalledTimes(2);
  await app.run('switch_branch', { ...args, name: 'feature/native-adapter' });
  await app.upload({ ...args, content: '# Branch source' });
  await app.run('switch_branch', { ...args, name: 'main' });
  expect(await readFile(path.join(app.directory, created.file), 'utf8')).toBe('# Baseline');
  await app.run('merge_branch', { ...args, name: 'feature/native-adapter' });
  expect((await app.run<CanvasBlock>('read_doc', args)).content).toBe('# Branch source');
  await app.run('restore_revision', { ...args, revision: versions.commits[0].id });
  expect(await readFile(path.join(app.directory, created.file), 'utf8')).toBe('# Baseline');
  expect(app.onChanged).toHaveBeenCalledTimes(7);
});

it('moves a document through the native registered tool and retains source, history, and references after restart', async () => {
  const app = await fixture();
  const sourceId = 'product-roadmap';
  const source = await app.read(`/canvases/${sourceId}`);
  const target = await app.request<CanvasDocument>(`/workspaces/${source.workspaceId}/canvases`, 'POST', { name: 'Move destination' });
  const remote = await app.request<CanvasDocument>(`/workspaces/${source.workspaceId}/canvases`, 'POST', { name: 'Inbound references' });
  const moving = await app.upload({ title: 'Moving native source', content: '# Baseline' });
  const edited = await app.upload({ blockId: moving.id, content: '# Durable source\nPreserve this entire file.' });
  const neighbor = await app.upload({ title: 'Source context', content: '# Keep this source here' });
  const destinationContext = await app.request<CanvasBlock>(`/canvases/${target.id}/blocks`, 'POST', { title: 'Destination context' });
  await app.request(`/canvases/${sourceId}/blocks/${moving.id}`, 'PUT', { links: [neighbor.id], linkTypes: { [neighbor.id]: 'related' },
    crossLinks: [{ canvasId: target.id, blockId: destinationContext.id, relation: 'prerequisite' }] });
  const reader = await app.request<CanvasBlock>(`/canvases/${sourceId}/blocks`, 'POST', { title: 'Source reader', links: [moving.id] });
  await app.request(`/canvases/${sourceId}/blocks/${reader.id}`, 'PUT', { linkTypes: { [moving.id]: 'implements' } });
  const portal = await app.request<CanvasBlock>(`/canvases/${remote.id}/blocks`, 'POST', { title: 'Remote reader' });
  await app.request(`/canvases/${remote.id}/blocks/${portal.id}`, 'PUT', {
    crossLinks: [{ canvasId: sourceId, blockId: moving.id, relation: 'same_topic', confidence: 0.9 }] });
  const history = await app.run<DocumentHistory>('list_versions', { blockId: moving.id });
  expect(history.commits.length).toBeGreaterThanOrEqual(2);
  const before = await app.read(`/canvases/${sourceId}`);
  const changedBefore = app.onChanged.mock.calls.length;

  await expect(app.run('move_document', { blockId: moving.id, targetCanvasId: 'missing-destination' })).rejects.toThrow('Canvas not found');
  await expect(app.run('move_document', { blockId: moving.id, targetCanvasId: ' ' })).rejects.toThrow();
  expect(await app.read(`/canvases/${sourceId}`)).toEqual(before);
  expect(app.onChanged).toHaveBeenCalledTimes(changedBefore);
  expect(await app.run('move_document', { blockId: moving.id, targetCanvasId: target.id }))
    .toEqual({ fromCanvasId: sourceId, toCanvasId: target.id, blockId: moving.id });
  expect(app.onChanged).toHaveBeenCalledTimes(changedBefore + 1);
  await expect(app.run('read_doc', { blockId: moving.id })).rejects.toThrow();
  const moved = await app.run<CanvasBlock>('read_doc', { canvasId: target.id, blockId: moving.id });
  expect(moved).toMatchObject({ id: moving.id, title: moving.title, file: moving.file, content: edited.content,
    links: [destinationContext.id], linkTypes: { [destinationContext.id]: 'prerequisite' },
    crossLinks: [{ canvasId: sourceId, blockId: neighbor.id, relation: 'related' }] });
  const sourceAfter = await app.read(`/canvases/${sourceId}`);
  expect(sourceAfter.blocks.find(block => block.id === reader.id)).toMatchObject({ links: [],
    crossLinks: [{ canvasId: target.id, blockId: moving.id, relation: 'implements' }] });
  const remoteAfter = await app.read(`/canvases/${remote.id}`);
  expect(remoteAfter.blocks.find(block => block.id === portal.id)?.crossLinks)
    .toEqual([{ canvasId: target.id, blockId: moving.id, relation: 'same_topic', confidence: 0.9 }]);
  expect(await readFile(path.join(app.directory, moving.file), 'utf8')).toBe(edited.content);
  expect(await app.run('list_versions', { canvasId: target.id, blockId: moving.id })).toEqual(history);

  await app.restart();
  expect(await app.run('read_doc', { canvasId: target.id, blockId: moving.id })).toEqual(moved);
  expect(await app.read(`/canvases/${sourceId}`)).toEqual(sourceAfter);
  expect(await app.read(`/canvases/${remote.id}`)).toEqual(remoteAfter);
  expect(await app.run('list_versions', { canvasId: target.id, blockId: moving.id })).toEqual(history);
  expect(await app.run('search_docs', { query: 'Preserve this entire file' }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ canvasId: target.id, blockId: moving.id })]));
});

it('creates and replaces actual local files using authoritative checkout manifests', async () => {
  const app = await fixture();
  const created = await app.upload({ filename: 'My notes.md', content: '# First source', x: -30, y: -90 });
  expect(created).toMatchObject({ title: 'My notes', content: '# First source', y: -90 });
  expect(await readFile(path.join(app.directory, created.file), 'utf8')).toBe('# First source');
  const changed = await app.upload({ blockId: created.id, title: 'Renamed source', content: '# Complete replacement' });
  expect(changed).toMatchObject({ id: created.id, title: 'Renamed source', content: '# Complete replacement' });
  expect(await readFile(path.join(app.directory, created.file), 'utf8')).toBe('# Complete replacement');
  expect(app.onChanged).toHaveBeenCalledTimes(2);
});

it('rejects incomplete upload and unchecked deletion without changing saved documents', async () => {
  const app = await fixture();
  const before = await app.read('/canvases/product-roadmap');
  await expect(app.run('upload_file', { filename: 'notes.md', content: 42 })).rejects.toThrow();
  await expect(app.run('delete_doc', { blockId: 'launch-checklist' })).rejects.toThrow();
  expectRestoredCanvas(await app.read('/canvases/product-roadmap'), before);
  expect(app.onChanged).not.toHaveBeenCalled();
});
