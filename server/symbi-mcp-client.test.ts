import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { conversationWorkspace } from './agent-workspace.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { symbiApiHeaders } from './jev-api-principal.js';
import { symbiMcpTools, type SymbiToolContext } from './symbi-mcp-client.js';

const roots: string[] = [];
const connections: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(close => close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-mcp-files-')); roots.push(root);
  const store = new CanvasStore(root); await store.init();
  const context: SymbiToolContext = { store, canvasId: 'product-roadmap', query: 'Find launch evidence',
    workdir: await conversationWorkspace(root, 'conversation-a'), navigationRequests: [], researchPatches: [] };
  const load = async (fetcher = createStoreApiFetcher(store)) => {
    const connected = await symbiMcpTools(context, { mcpApiBase: 'http://symbi.internal/api',
      mcpFetcher: fetcher, mcpHeaders: symbiApiHeaders() });
    connections.push(connected.close);
    const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const tool = connected.tools.find(tool => tool.name === name);
      if (!tool) throw new Error(`Missing canonical MCP tool ${name}`);
      return JSON.parse(String(await tool.invoke(args, { signal })));
    };
    return { ...connected, invoke };
  };
  return { root, store, context, load };
}

it('discovers the complete canonical catalog including Jev actions and reviewer operations', async () => {
  const setup = await fixture();
  const { tools } = await setup.load();
  const names = tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['ask_symbi', 'symbi_reflex', 'find_by', 'related', 'jev_do', 'jev_job',
    'jev_resolve', 'jev_undo', 'jev_configure', 'download_file', 'upload_file', 'list_todos', 'restore_revision', 'draw_research_canvas']));
  expect(names).not.toEqual(expect.arrayContaining(['create_doc', 'edit_doc']));
  expect(new Set(names).size).toBe(names.length);
  const cancelled = new AbortController(); cancelled.abort(new Error('Discovery cancelled'));
  setup.context.signal = cancelled.signal;
  await expect(setup.load()).rejects.toThrow('Discovery cancelled');
});

it('uses a canonical tool name when the SDK catalog omits its optional description', async () => {
  const setup = await fixture();
  const listTools = Client.prototype.listTools;
  const observation = vi.spyOn(Client.prototype, 'listTools').mockImplementation(async function (this: Client, params, options) {
    const catalog = await listTools.call(this, params, options);
    return { ...catalog, tools: catalog.tools.map(tool => tool.name === 'read_doc' ? { ...tool, description: undefined } : tool) };
  });
  try {
    const { tools, invoke } = await setup.load();
    expect(tools.find(tool => tool.name === 'read_doc')?.description).toBe('read_doc');
    expect(await invoke('read_doc', { blockId: 'launch-checklist' })).toMatchObject({ id: 'launch-checklist' });
    expect(setup.context.readSources).toEqual([expect.objectContaining({ blockId: 'launch-checklist' })]);
  } finally { observation.mockRestore(); }
});

it('downloads, edits, uploads and reads back an MDX working file across connection reloads', async () => {
  const setup = await fixture();
  const block = await setup.store.createBlock('product-roadmap', { title: 'Launch chart', kind: 'mdx', content: '<Chart values="1,2" />' });
  const first = await setup.load();
  const downloaded = await first.invoke('download_file', { blockId: block.id });
  expect(downloaded.filename).toMatch(/\.mdx$/);
  const local = path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, ''));
  expect(await readFile(local, 'utf8')).toBe(block.content);
  expect(JSON.parse(await readFile(`${local}.symbi.json`, 'utf8'))).toMatchObject({ documentId: block.id, kind: 'mdx' });
  await writeFile(local, '<Chart values="3,4" />');
  const second = await setup.load();
  const receipt = await second.invoke('upload_file', { sourcePath: downloaded.savedTo, mode: 'replace' });
  expect(receipt).toBeTruthy();
  const reopened = await new CanvasStore(setup.root).getCanvasBlock('product-roadmap', block.id);
  expect(reopened).toMatchObject({ kind: 'mdx', content: '<Chart values="3,4" />' });
  expect(await second.invoke('read_doc', { blockId: block.id })).toMatchObject({ content: reopened.content });
  expect(await conversationWorkspace(setup.root, 'conversation-a')).toBe(setup.context.workdir);
  expect(await conversationWorkspace(setup.root, 'conversation-b')).not.toBe(setup.context.workdir);
});

it('preserves edited local source on a stale upload and rejects direct content editing', async () => {
  const setup = await fixture();
  const { invoke } = await setup.load();
  const downloaded = await invoke('download_file', { blockId: 'launch-checklist' });
  const local = path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, ''));
  await writeFile(local, '# Agent changes kept locally');
  await setup.store.updateBlock('product-roadmap', 'launch-checklist', { content: '# Concurrent human changes' });
  await expect(invoke('upload_file', { sourcePath: downloaded.savedTo, mode: 'replace' })).rejects.toThrow();
  expect(await readFile(local, 'utf8')).toBe('# Agent changes kept locally');
  expect((await setup.store.getCanvasBlock('product-roadmap', 'launch-checklist')).content).toBe('# Concurrent human changes');
  await expect(invoke('upload_file', { sourcePath: downloaded.savedTo, content: '# Bypass', mode: 'replace' })).rejects.toThrow();
});

it('rejects paths outside the workspace and protects an unsaved editor document', async () => {
  const setup = await fixture();
  const { invoke } = await setup.load();
  await expect(invoke('download_file', { blockId: 'launch-checklist', destinationPath: '../escape.md' })).rejects.toThrow('inside the conversation');
  const downloaded = await invoke('download_file', { blockId: 'launch-checklist' });
  const local = path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, ''));
  await writeFile(local, '# Agent working file');
  setup.context.currentView = { selectedBlockIds: [], editingBlockId: 'launch-checklist', editorHasUnsavedChanges: true };
  await expect(invoke('upload_file', { sourcePath: downloaded.savedTo, mode: 'replace' })).rejects.toThrow('Save or discard');
  setup.context.currentView.editingBlockId = 'other-document';
  await invoke('upload_file', { sourcePath: downloaded.savedTo, mode: 'replace' });
  expect((await setup.store.getCanvasBlock('product-roadmap', 'launch-checklist')).content).toBe('# Agent working file');
  await writeFile(path.join(setup.context.workdir, 'new.md'), '# Independent new document');
  const created = await invoke('upload_file', { sourcePath: '/new.md', mode: 'create' });
  expect((await setup.store.getCanvasBlock('product-roadmap', created.blockId)).content).toBe('# Independent new document');
});

it('harvests canonical MCP navigation and research presentation results', async () => {
  const setup = await fixture();
  const { invoke } = await setup.load();
  await expect(invoke('show_doc_on_canvas', { blockId: 'missing-document' })).rejects.toThrow();
  await invoke('show_doc_on_canvas', { blockId: 'launch-checklist' });
  expect(setup.context.navigationRequests).toEqual([expect.objectContaining({ kind: 'document', blockId: 'launch-checklist' })]);
  await invoke('draw_research_canvas', { blocks: [{ id: 'evidence', type: 'text', title: 'Launch evidence', content: 'Requires QA.',
    sourceIds: ['product-roadmap:launch-checklist'] }], edges: [] });
  expect(setup.context.researchPatches).toEqual([expect.objectContaining({ query: 'Find launch evidence', blocks: [expect.objectContaining({ id: 'evidence' })] })]);
});

it('keeps failed reads out of actual source citations and refreshes a repeated read to its current hash', async () => {
  const setup = await fixture(); const { invoke } = await setup.load();
  await expect(invoke('read_doc', { blockId: 'missing-document' })).rejects.toThrow();
  expect(setup.context.readSources ?? []).toEqual([]);
  await invoke('read_doc', { blockId: 'launch-checklist' });
  const changed = await setup.store.updateBlock('product-roadmap', 'launch-checklist', { content: '# Current QA source' });
  await invoke('read_doc', { blockId: 'launch-checklist' });
  expect(setup.context.readSources).toEqual([expect.objectContaining({ blockId: changed.id, contentHash: changed.contentHash,
    evidence: expect.objectContaining({ passageKind: 'exact', passage: changed.content }) })]);
});

it('retains a successful document read with exact citation when canvas metadata is unavailable', async () => {
  const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
  const { invoke } = await setup.load(async (input, init) => new URL(String(input)).pathname === '/api/canvases/product-roadmap'
    ? Response.json({ error: 'Canvas metadata unavailable' }, { status: 503 }) : api(input, init));
  const document = await invoke('read_doc', { blockId: 'launch-checklist' });
  expect(document.id).toBe('launch-checklist');
  expect(setup.context.readSources).toEqual([expect.objectContaining({ canvasName: 'product-roadmap', blockId: document.id,
    contentHash: document.contentHash, evidence: expect.objectContaining({ passageKind: 'exact' }) })]);
});

it('propagates cancellation during source metadata hydration without recording a citation', async () => {
  const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
  const controller = new AbortController();
  let metadataRequested!: () => void;
  const started = new Promise<void>(resolve => { metadataRequested = resolve; });
  const { invoke } = await setup.load(async (input, init) => {
    if (new URL(String(input)).pathname !== '/api/canvases/product-roadmap') return api(input, init);
    metadataRequested();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  const reading = invoke('read_doc', { blockId: 'launch-checklist' }, controller.signal);
  const rejected = expect(reading).rejects.toThrow('Metadata read cancelled');
  await started; controller.abort(new Error('Metadata read cancelled'));
  await rejected;
  expect(setup.context.readSources ?? []).toEqual([]);
  // Cancellation settles the client before the canonical handler finishes its durable audit.
  await expect.poll(async () => (await setup.store.mcpActivity()).entries.some(entry => entry.tool === 'read_canvas' && entry.outcome === 'error'))
    .toBe(true);
});

it('rejects a null canonical document response without recording a source', async () => {
  const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
  const { invoke } = await setup.load(async (input, init) => new URL(String(input)).pathname.endsWith('/blocks/launch-checklist')
    ? Response.json(null) : api(input, init));
  await expect(invoke('read_doc', { blockId: 'launch-checklist' })).rejects.toThrow(/null/);
  expect(setup.context.readSources ?? []).toEqual([]);
});

it.each(['unexpected response', {}, { id: 'other', title: 'Other', content: '# Other' },
  { id: 'launch-checklist', title: 'Launch', content: 42 }, { id: 'launch-checklist', title: 42, content: '# Launch' }])
  ('keeps malformed successful document results out of source citations: %j', async malformed => {
    const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
    const { tools } = await setup.load(async (input, init) => new URL(String(input)).pathname.endsWith('/blocks/launch-checklist')
      ? Response.json(malformed) : api(input, init));
    const reader = tools.find(tool => tool.name === 'read_doc')!;
    expect(await reader.invoke({ blockId: 'launch-checklist' })).toBe(typeof malformed === 'string' ? malformed : JSON.stringify(malformed));
    expect(setup.context.readSources ?? []).toEqual([]);
  });

it('edits an expanded website project using actual local source files and commits additions and removals', async () => {
  const setup = await fixture();
  const { invoke } = await setup.load();
  await writeFile(path.join(setup.root, 'sites/team-docs/docs/remove.md'), '# Remove during local editing');
  const downloaded = await invoke('download_file', { blockId: 'team-docs' });
  const source = path.join(setup.context.workdir, downloaded.sourceDirectory.replace(/^\//, ''));
  await writeFile(path.join(source, 'docs/index.md'), '# Website source edited in the local environment');
  await writeFile(path.join(source, 'docs/new.md'), '# Added locally');
  await rm(path.join(source, 'docs/remove.md'));
  const result = await invoke('upload_file', { mode: 'replace', sourcePath: downloaded.savedTo });
  expect(result).toMatchObject({ kind: 'website', blockId: 'team-docs' });
  expect(await readFile(path.join(setup.root, 'sites/team-docs/docs/index.md'), 'utf8')).toBe('# Website source edited in the local environment');
  expect(await readFile(path.join(setup.root, 'sites/team-docs/docs/new.md'), 'utf8')).toBe('# Added locally');
  await expect(readFile(path.join(setup.root, 'sites/team-docs/docs/remove.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await new CanvasStore(setup.root).getCanvasBlock('product-roadmap', 'team-docs')).kind).toBe('website');
});

it('prepares a canonical uploaded proposal for review without saving its edited document', async () => {
  const setup = await fixture();
  const { invoke } = await setup.load();
  const before = await setup.store.getCanvasBlock('product-roadmap', 'launch-checklist');
  const downloaded = await invoke('download_file', { blockId: before.id });
  expect(downloaded).not.toHaveProperty('content');
  const local = path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, ''));
  await writeFile(local, '# Pending file review');
  const receipt = await invoke('upload_file', { mode: 'propose', sourcePath: downloaded.savedTo });
  expect(receipt).toMatchObject({ mode: 'propose', saved: false });
  expect(setup.context.proposals).toEqual([expect.objectContaining({ id: receipt.proposalId, status: 'pending',
    changes: [expect.objectContaining({ blockId: before.id, after: expect.objectContaining({ content: '# Pending file review' }) })] })]);
  expect(await invoke('upload_file', { mode: 'propose', sourcePath: downloaded.savedTo })).toEqual(receipt);
  expect(setup.context.proposals).toHaveLength(1);
  expect((await setup.store.getCanvasBlock('product-roadmap', before.id)).content).toBe(before.content);
  await invoke('apply_file_proposal', { proposalId: receipt.proposalId });
  expect(setup.context.proposals).toEqual([]);
  expect((await new CanvasStore(setup.root).getCanvasBlock('product-roadmap', before.id)).content).toBe('# Pending file review');
});

it('reports a saved proposal review read failure and recovers the same proposal on upload retry', async () => {
  const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
  const first = await setup.load(async (input, init) => new URL(String(input)).pathname.startsWith('/api/file-proposals/')
    ? Response.json({ error: 'Review temporarily unavailable' }, { status: 503 }) : api(input, init));
  const before = await setup.store.getCanvasBlock('product-roadmap', 'launch-checklist');
  const downloaded = await first.invoke('download_file', { blockId: before.id });
  await writeFile(path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, '')), '# Pending despite interrupted review');
  const input = { mode: 'propose', sourcePath: downloaded.savedTo };
  await expect(first.invoke('upload_file', input)).rejects.toThrow('The upload proposal was saved but could not be loaded for review');
  expect(setup.context.proposals ?? []).toEqual([]);
  expect((await setup.store.getCanvasBlock('product-roadmap', before.id)).content).toBe(before.content);
  const retry = await setup.load();
  const receipt = await retry.invoke('upload_file', input);
  expect(receipt).toMatchObject({ saved: false, mode: 'propose' });
  expect(setup.context.proposals).toEqual([expect.objectContaining({ id: receipt.proposalId, status: 'pending' })]);
  expect(await retry.invoke('upload_file', input)).toEqual(receipt);
  expect(setup.context.proposals).toHaveLength(1);
  expect((await setup.store.getCanvasBlock('product-roadmap', before.id)).content).toBe(before.content);
});

it('hydrates a saved proposal in its requested canvas when the upload receipt omits canvas metadata', async () => {
  const setup = await fixture(); const api = createStoreApiFetcher(setup.store);
  const { invoke } = await setup.load(async (input, init) => {
    const response = await api(input, init);
    if (new URL(String(input)).pathname !== '/api/file-uploads') return response;
    const receipt = await response.json(); delete receipt.canvasId;
    return Response.json(receipt);
  });
  const downloaded = await invoke('download_file', { blockId: 'launch-checklist' });
  await writeFile(path.join(setup.context.workdir, downloaded.savedTo.replace(/^\//, '')), '# Pending review');
  const receipt = await invoke('upload_file', { mode: 'propose', sourcePath: downloaded.savedTo });
  expect(setup.context.proposals).toEqual([expect.objectContaining({ id: receipt.proposalId, status: 'pending' })]);
});
