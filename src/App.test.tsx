// @vitest-environment jsdom
import { advertisedTool, projectMcpDefinitions } from '../server/mcp-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { App } from './App';
import type { CanvasBlock, CanvasDocument, ChatSettings, WorkspaceSummary } from '../shared/types';
import type { AnswerCanvasResult, CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas';

const initialWorkspace: WorkspaceSummary = { id: 'team', name: 'Product team', canvases: [{ id: 'planning', name: 'Planning' }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function editorView(scope: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(within(scope).getByLabelText('Markdown source'));
  if (!view) throw new Error('Missing CodeMirror editor');
  return view;
}

function editorText(scope: HTMLElement): string { return editorView(scope).state.doc.toString(); }

function typeInEditor(scope: HTMLElement, text: string): void {
  const view = editorView(scope);
  act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); });
}

function fixture(options: {
  failSettingsSave?: boolean;
  empty?: boolean;
  initialBlocks?: CanvasBlock[];
  hasApiKey?: boolean;
  chatReplies?: Array<{ message: string; changed: boolean } | { error: string } | Promise<{ message: string; changed: boolean } | { error: string }>>;
  answerCanvas?: AnswerCanvasResult;
  researchPatch?: ResearchCanvasPatch;
  canvasReplyIndices?: number[];
  navigationReplyIndices?: number[];
  chatNavigation?: CanvasNavigationTarget;
  failCanvas?: boolean;
  failCanvasDelete?: boolean;
  failWorkspaceDelete?: boolean;
  failSearch?: boolean;
  failBlockUpdate?: boolean;
  failBlockDelete?: boolean;
  searchResults?: Array<{ canvasId: string; blockId: string; title: string; excerpt: string }>;
  failWorkspaces?: boolean;
  failCanvasAfterFirst?: boolean;
  failLayout?: boolean;
} = {}) {
  const workspaces = options.empty ? [] : [structuredClone(initialWorkspace)];
  const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: structuredClone(options.initialBlocks ?? []) };
  const canvases = new Map<string, CanvasDocument>([[canvas.id, canvas]]);
  let settings: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: options.hasApiKey ?? false };
  const requests: { path: string; method: string; body: unknown }[] = [];
  let chatIndex = 0;
  let canvasReads = 0;
  const fetchResponse = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestPath = String(input).replace(/^(\/api\/canvases\/[^/?]+)\?summary=1$/, '$1');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ path: requestPath, method, body });
    if (requestPath === '/api/mcp/browser' && method === 'GET') return Response.json({ tools: projectMcpDefinitions().map(advertisedTool) });
    if (requestPath === '/api/mcp/browser' && method === 'POST') {
      const args = body?.arguments as Record<string, unknown>;
      const result = await fetchResponse(`/api/canvases/${String(args.canvasId)}/blocks`, { method: 'POST', body: JSON.stringify(args) });
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(await result.json()) }], isError: !result.ok });
    }
    if (requestPath === '/api/workspaces' && method === 'GET') {
      if (options.failWorkspaces) return Response.json({ error: 'Workspace unavailable' }, { status: 503 });
      return Response.json(workspaces);
    }
    if (requestPath === '/api/workspaces' && method === 'POST') {
      const created: WorkspaceSummary = { id: 'new-team-' + (workspaces.length + 1), name: String(body?.name), canvases: [] };
      workspaces.push(created);
      return Response.json(created);
    }
    const workspaceRoute = requestPath.match(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceRoute && method === 'DELETE') {
      if (options.failWorkspaceDelete) return Response.json({ error: 'Workspace could not be deleted' }, { status: 503 });
      const index = workspaces.findIndex(workspace => workspace.id === workspaceRoute[1]);
      if (index < 0) return Response.json({ error: 'Workspace missing' }, { status: 404 });
      for (const item of workspaces[index].canvases) canvases.delete(item.id);
      workspaces.splice(index, 1);
      return Response.json({ ok: true });
    }
    if (requestPath === '/api/settings' && method === 'GET') return Response.json(settings);
    if (requestPath === '/api/settings' && method === 'PUT') {
      if (options.failSettingsSave) return Response.json({ error: 'Settings could not be saved' }, { status: 503 });
      settings = { ...settings, model: String(body?.model), systemPrompt: String(body?.systemPrompt), agentProfile: body?.agentProfile as ChatSettings['agentProfile'], agentPlugins: body?.agentPlugins as ChatSettings['agentPlugins'], hasApiKey: Boolean(body?.apiKey) || settings.hasApiKey };
      return Response.json(settings);
    }
    const newCanvas = requestPath.match(/^\/api\/workspaces\/([^/]+)\/canvases$/);
    if (newCanvas && method === 'POST') {
      const created: CanvasDocument = { id: 'canvas-' + canvases.size, name: String(body?.name), workspaceId: newCanvas[1], blocks: [] };
      canvases.set(created.id, created);
      workspaces.find(workspace => workspace.id === created.workspaceId)?.canvases.push({ id: created.id, name: created.name });
      return Response.json(created);
    }
    const canvasRoute = requestPath.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasRoute && method === 'GET') {
      canvasReads++;
      if (options.failCanvas || (options.failCanvasAfterFirst && canvasReads > 1)) return Response.json({ error: 'Canvas unavailable' }, { status: 503 });
      const document = canvases.get(canvasRoute[1]);
      return document ? Response.json(document) : Response.json({ error: 'Canvas missing' }, { status: 404 });
    }
    if (canvasRoute && method === 'DELETE') {
      if (options.failCanvasDelete) return Response.json({ error: 'Canvas could not be deleted' }, { status: 503 });
      if (!canvases.has(canvasRoute[1])) return Response.json({ error: 'Canvas missing' }, { status: 404 });
      canvases.delete(canvasRoute[1]);
      for (const workspace of workspaces) workspace.canvases = workspace.canvases.filter(item => item.id !== canvasRoute[1]);
      return Response.json({ ok: true });
    }
    const moveRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)\/move$/);
    if (moveRoute && method === 'POST') {
      const source = canvases.get(moveRoute[1]);
      const target = canvases.get(String(body?.targetCanvasId));
      const block = source?.blocks.find(item => item.id === moveRoute[2]);
      if (!source || !target || !block) return Response.json({ error: 'Move target missing' }, { status: 404 });
      source.blocks.splice(source.blocks.indexOf(block), 1);
      target.blocks.push(block);
      return Response.json({ fromCanvasId: source.id, toCanvasId: target.id, blockId: block.id });
    }
    const layoutRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/layout$/);
    if (layoutRoute && method === 'PUT') {
      if (options.failLayout) return Response.json({ error: 'Layout could not be saved' }, { status: 503 });
      const document = canvases.get(layoutRoute[1]);
      if (!document) return Response.json({ error: 'Canvas missing' }, { status: 404 });
      for (const position of body?.positions as Array<{ blockId: string; x: number; y: number }>) {
        const block = document.blocks.find(item => item.id === position.blockId);
        if (block) Object.assign(block, position);
      }
      return Response.json(document);
    }
    const blocksRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/blocks$/);
    if (blocksRoute && method === 'POST') {
      const document = canvases.get(blocksRoute[1]);
      if (!document) return Response.json({ error: 'Canvas missing' }, { status: 404 });
      const id = String(body?.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const block: CanvasBlock = {
        id, file: id + '.md', title: String(body?.title), kind: body?.kind as CanvasBlock['kind'], content: String(body?.content),
        x: Number(body?.x ?? 100), y: Number(body?.y ?? 100), width: 350, height: 250,
        links: (body?.links as string[]) ?? [], tags: (body?.tags as string[]) ?? [],
        purpose: body?.purpose as string | undefined, workArea: body?.workArea as string | undefined,
      };
      document.blocks.push(block);
      return Response.json(block);
    }
    const blockRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
    if (blockRoute) {
      const document = canvases.get(blockRoute[1]);
      const block = document?.blocks.find(item => item.id === blockRoute[2]);
      if (!document || !block) return Response.json({ error: 'Block missing' }, { status: 404 });
      if (method === 'GET') return Response.json(block);
      if (method === 'PUT') {
        if (options.failBlockUpdate) return Response.json({ error: 'Document could not be saved' }, { status: 503 });
        Object.assign(block, body);
        return Response.json(block);
      }
      if (method === 'DELETE') {
        if (options.failBlockDelete) return Response.json({ error: 'Document could not be deleted' }, { status: 503 });
        document.blocks.splice(document.blocks.indexOf(block), 1);
        return Response.json({ ok: true });
      }
    }
    if (requestPath.startsWith('/api/search?q=')) {
      if (options.failSearch) return Response.json({ error: 'Search unavailable' }, { status: 503 });
      if (options.searchResults) return Response.json(options.searchResults);
      const query = decodeURIComponent(requestPath.split('q=')[1]).toLowerCase();
      return Response.json([...canvases.values()].flatMap(document => document.blocks
        .filter(block => (block.title + block.content).toLowerCase().includes(query))
        .map(block => ({ canvasId: document.id, blockId: block.id, title: block.title, excerpt: block.content }))));
    }
    if (requestPath === '/api/chat/stream' && method === 'POST') {
      const replyIndex = chatIndex++;
      const reply = await (options.chatReplies?.[replyIndex] ?? { message: 'Canvas summarized.', changed: false });
      if ('error' in reply) return Response.json({ error: reply.error }, { status: 502 });
      const chunk = JSON.stringify({ choices: [{ delta: { content: reply.message } }] });
      const lastMessage = (body?.messages as Array<{ content: string }> | undefined)?.at(-1)?.content;
      const researchReply = !options.canvasReplyIndices || options.canvasReplyIndices.includes(chatIndex);
      const sourceEvent = researchReply && options.answerCanvas ? `event: answer_canvas\ndata: ${JSON.stringify({ ...options.answerCanvas, query: lastMessage ?? options.answerCanvas.query })}\n\n` : '';
      const patchEvent = researchReply && options.researchPatch ? `event: research_canvas_patch\ndata: ${JSON.stringify({ ...options.researchPatch, query: lastMessage ?? options.researchPatch.query })}\n\n` : '';
      const navigationEvent = options.chatNavigation && options.navigationReplyIndices?.includes(chatIndex)
        ? `event: canvas_navigation\ndata: ${JSON.stringify(options.chatNavigation)}\n\n` : '';
      return new Response(`${sourceEvent}${patchEvent}${navigationEvent}data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ error: 'Unexpected request: ' + method + ' ' + requestPath }, { status: 500 });
  };
  return { canvas, canvases, workspaces, requests, fetchResponse };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.removeItem('symbiknow.theme');
  window.localStorage.removeItem('symbiknow.assistant.document-width');
  window.localStorage.removeItem('symbiknow:research-session');
  window.localStorage.removeItem('symbiknow:chat-history');
  document.documentElement.removeAttribute('data-theme');
  // CodeMirror measures text ranges, which jsdom does not lay out.
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) });
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App composition', () => {
  it('opens an old Tasks link on the canvas without a Tasks page or plugin', async () => {
    window.history.replaceState(null, '', '/?canvas=planning&view=tasks');
    vi.stubGlobal('fetch', vi.fn(fixture().fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    expect(window.location.search).toBe('?canvas=planning');
    expect(screen.queryByRole('button', { name: 'Open Tasks page' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).queryByText('Shared tasks')).toBeNull();
  });

  it('confirms workspace deletion and moves to a surviving workspace, then the empty state', async () => {
    const server = fixture();
    server.workspaces.push({ id: 'design', name: 'Design team', canvases: [{ id: 'design-notes', name: 'Design notes' }] });
    server.canvases.set('design-notes', { id: 'design-notes', name: 'Design notes', workspaceId: 'design', blocks: [] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace: Product team' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace' });
    expect(within(dialog).getByText(/1 canvas, including all documents/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.workspaces).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace: Product team' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete workspace' })).getByRole('button', { name: 'Delete workspace' }));
    expect(await screen.findByRole('region', { name: 'Design notes infinite canvas' })).toBeTruthy();
    expect(server.canvases.has('planning')).toBe(false);
    expect(window.location.search).toContain('canvas=design-notes');
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace: Design team' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete workspace' })).getByRole('button', { name: 'Delete workspace' }));
    expect(await screen.findByRole('button', { name: 'Create workspace' })).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('keeps the workspace and confirmation open when deletion fails', async () => {
    const server = fixture({ failWorkspaceDelete: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace: Product team' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete workspace' })).getByRole('button', { name: 'Delete workspace' }));
    expect(await within(screen.getByRole('dialog', { name: 'Delete workspace' })).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Workspace could not be deleted'));
    expect(server.workspaces).toHaveLength(1);
    expect(server.canvases.has('planning')).toBe(true);
  });

  it('confirms canvas deletion, keeps the current view on failure, and moves to a surviving canvas', async () => {
    const server = fixture();
    server.workspaces[0].canvases.push({ id: 'research', name: 'Research' });
    server.canvases.set('research', { id: 'research', name: 'Research', workspaceId: 'team', blocks: [] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete canvas: Planning' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete canvas' });
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.canvases.has('planning')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete canvas: Planning' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete canvas' })).getByRole('button', { name: 'Delete canvas' }));
    expect(await screen.findByRole('region', { name: 'Research infinite canvas' })).toBeTruthy();
    expect(server.canvases.has('planning')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Open canvas: Planning' })).toBeNull();
    expect(window.location.search).toContain('canvas=research');
    fireEvent.click(screen.getByRole('button', { name: 'Delete canvas: Research' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete canvas' })).getByRole('button', { name: 'Delete canvas' }));
    expect(await screen.findByRole('button', { name: 'Create canvas' })).toBeTruthy();
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }));
    const createDialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(createDialog).getByLabelText('Canvas name'), { target: { value: 'Next' } });
    fireEvent.click(within(createDialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Next' })).toBeTruthy();
  });

  it('leaves the canvas intact when deletion fails', async () => {
    const server = fixture({ failCanvasDelete: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete canvas: Planning' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete canvas' })).getByRole('button', { name: 'Delete canvas' }));
    expect(await within(screen.getByRole('dialog', { name: 'Delete canvas' })).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Canvas could not be deleted'));
    expect(screen.getByRole('dialog', { name: 'Delete canvas' })).toBeTruthy();
    expect(server.canvases.has('planning')).toBe(true);
  });
  it('requests fresh canvas metadata on each navigation and shows server updates on return', async () => {
    const server = fixture();
    server.workspaces[0].canvases.push({ id: 'research', name: 'Research' });
    server.canvases.set('research', { id: 'research', name: 'Research', workspaceId: 'team', blocks: [] });
    const reads: Array<{ path: string; init?: RequestInit }> = [];
    const returnRead = deferred<void>();
    let holdReturn = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const match = path.match(/^\/api\/canvases\/(planning|research)\?summary=1$/);
      if (match) {
        reads.push({ path, init });
        if (holdReturn && match[1] === 'planning') await returnRead.promise;
        const response = await server.fetchResponse(input, init);
        return new Response(await response.text(), { status: response.status,
          headers: { 'content-type': 'application/json', ETag: `"${match[1]}-v1"` } });
      }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Research' }));
    expect(await screen.findByRole('region', { name: 'Research infinite canvas' })).toBeTruthy();
    server.canvas.name = 'Planning refreshed from server';
    holdReturn = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Planning' }));
    expect(await screen.findByRole('heading', { name: 'Loading canvas…' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Planning infinite canvas' })).toBeNull();
    await act(async () => { returnRead.resolve(); });
    expect(await screen.findByRole('region', { name: 'Planning refreshed from server infinite canvas' })).toBeTruthy();
    expect(reads.map(read => read.path)).toEqual(['/api/canvases/planning?summary=1', '/api/canvases/research?summary=1', '/api/canvases/planning?summary=1']);
    for (const read of reads) {
      expect(read.init?.cache).toBe('no-store');
      expect(new Headers(read.init?.headers).has('If-None-Match')).toBe(false);
    }
  });

  it('shows the SymbiKnow identity and keeps the selected dark mode after remount', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    const first = render(<App/>);
    expect(await screen.findByText('symbiknow')).toBeTruthy();
    expect(screen.getByText('People + AI · infinite canvas')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('symbiknow.theme')).toBe('dark');
    first.unmount();

    render(<App/>);
    expect(await screen.findByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('opens on the canvas at mobile width and lets the user open the assistant', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 620px)' }));
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(false);
  });

  it('uses the empty canvas to introduce shared knowledge and start a document', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Make knowledge together.' })).toBeTruthy();
    expect(screen.getByText(/team and its AI agents can connect, organize, and build on it/)).toBeTruthy();
    const prompt = document.querySelector<HTMLElement>('.canvas-empty-prompt');
    expect(prompt).toBeTruthy();
    expect(within(prompt!).getByRole('button', { name: 'Upload files' })).toBeTruthy();
    fireEvent.click(within(prompt!).getByRole('button', { name: 'Create note' }));
    expect(screen.getByRole('dialog', { name: 'Document editor' })).toBeTruthy();
  });

  it('saves OpenRouter settings and reflects the connected model without revealing the key', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.change(within(settingsDialog).getByLabelText('Model'), { target: { value: 'anthropic/claude-sonnet-4' } });
    fireEvent.change(within(settingsDialog).getByLabelText(/^OpenRouter API key/), { target: { value: 'sk-or-v1-secret' } });
    fireEvent.change(within(settingsDialog).getByLabelText('System prompt'), { target: { value: 'Be concise.' } });
    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(await screen.findByText('anthropic/claude-sonnet-4', {}, { timeout: 5000 })).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-or-v1-secret');
    expect(server.requests.find(request => request.path === '/api/settings' && request.method === 'PUT')?.body)
      .toMatchObject({ model: 'anthropic/claude-sonnet-4', apiKey: 'sk-or-v1-secret', systemPrompt: 'Be concise.' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getAllByText('Connected')).toHaveLength(1);
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getByText(/A key is saved/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Cancel' }));
  });

  it('saves the selected agent profile and plugin access from the settings page', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Agent profile/ }), { target: { value: 'planner' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Plugins & loaders/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Outside MCP servers/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(server.requests.find(request => request.path === '/api/settings' && request.method === 'PUT')?.body)
      .toMatchObject({ agentProfile: 'planner', agentPlugins: [] });
  });

  it('opens a full-page reader with its own URL, pages through documents, and returns with Back', async () => {
    const block: CanvasBlock = { id: 'read-me', title: 'Read me', file: 'docs/read-me.md', kind: 'markdown',
      content: '# Full document\n\nAll of this content is readable.', x: 100, y: 100, width: 400, height: 250, links: [] };
    const second: CanvasBlock = { ...block, id: 'next-doc', title: 'Next doc', file: 'docs/next-doc.md', content: '# Second\n\nMore reading.', x: 600 };
    const server = fixture({ initialBlocks: [block, second] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Read Read me full page' }));
    const reader = screen.getByRole('dialog', { name: 'Read me full page' });
    expect(within(reader).getByText('All of this content is readable.')).toBeTruthy();
    expect(window.location.search).toBe('?canvas=planning&doc=read-me');
    expect(within(reader).getByText('1 / 2')).toBeTruthy();
    fireEvent.click(within(reader).getByRole('button', { name: 'Next document' }));
    expect(await screen.findByRole('dialog', { name: 'Next doc full page' })).toBeTruthy();
    expect(window.location.search).toBe('?canvas=planning&doc=next-doc');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(await screen.findByRole('dialog', { name: 'Read me full page' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Read me full page' })).getByRole('button', { name: '← Back to canvas' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Read me full page' })).toBeNull());
    expect(window.location.search).toBe('?canvas=planning');
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
  });

  it('opens a shared document link directly in the reader', async () => {
    const block: CanvasBlock = { id: 'shared', title: 'Shared page', file: 'docs/shared.md', kind: 'markdown',
      content: '# Shared\n\nOpened from a link.', x: 0, y: 0, width: 400, height: 250, links: [] };
    window.history.replaceState(null, '', '/?canvas=planning&doc=shared');
    const server = fixture({ initialBlocks: [block] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('dialog', { name: 'Shared page full page' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Back to canvas' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Shared page full page' })).toBeNull());
    expect(window.location.search).toBe('?canvas=planning');
  });

  it('opens a document on another canvas from its canvas and document URL', async () => {
    const target: CanvasBlock = { id: 'billing-client', title: 'Billing client', file: 'docs/billing-client.md', kind: 'markdown',
      content: '# Billing client\n\nRate limits apply.', x: 0, y: 0, width: 400, height: 250, links: [] };
    const server = fixture();
    server.workspaces[0].canvases.push({ id: 'billing', name: 'Billing' });
    server.canvases.set('billing', { id: 'billing', name: 'Billing', workspaceId: 'team', blocks: [target] });
    window.history.replaceState(null, '', '/?canvas=billing&doc=billing-client');
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));

    render(<App/>);
    const reader = await screen.findByRole('dialog', { name: 'Billing client full page' });
    expect(within(reader).getByText('Rate limits apply.')).toBeTruthy();
    expect(window.location.search).toBe('?canvas=billing&doc=billing-client');
    expect(server.requests.some(request => request.path === '/api/canvases/billing')).toBe(true);
  });

  it('opens a cross-canvas chip in the target canvas reader', async () => {
    const source: CanvasBlock = { id: 'rate-limits', title: 'Rate limits', file: 'rate-limits.md', kind: 'markdown',
      content: '# Rate limits', x: 0, y: 0, width: 400, height: 250, links: [],
      crossLinks: [{ canvasId: 'billing', blockId: 'billing-client', relation: 'implements', confidence: 0.9 }] };
    const target: CanvasBlock = { ...source, id: 'billing-client', title: 'Billing client', file: 'billing-client.md',
      content: '# Billing client\n\nRelated API details.', crossLinks: [] };
    const server = fixture({ initialBlocks: [source] });
    server.workspaces[0].canvases.push({ id: 'billing', name: 'Billing' });
    server.canvases.set('billing', { id: 'billing', name: 'Billing', workspaceId: 'team', blocks: [target] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));

    render(<App/>);
    expect(await screen.findByText('↗ Other canvas: Billing · Billing client')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open related document billing-client on canvas billing' }));
    const reader = await screen.findByRole('dialog', { name: 'Billing client full page' });
    expect(within(reader).getByText('Related API details.')).toBeTruthy();
    expect(window.location.search).toBe('?canvas=billing&doc=billing-client');
    expect(server.requests.some(request => request.path === '/api/canvases/billing')).toBe(true);
  });

  it('opens Symbi beside an editor and reader with the current document as context', async () => {
    const block: CanvasBlock = { id: 'guide', title: 'Guide', file: 'guide.md', kind: 'markdown', content: '# Guide',
      contentHash: 'first-version', x: 0, y: 0, width: 400, height: 280, links: [] };
    const server = fixture({ initialBlocks: [block], hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Guide' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Ask Symbi' }));
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    await waitFor(() => expect(document.activeElement).toBe(compose));
    const resizeHandle = screen.getByRole('separator', { name: 'Resize chat panel' });
    const startingWidth = Number(resizeHandle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe(String(startingWidth + 24));
    expect(document.querySelector('.app-shell')?.getAttribute('style')).toContain(`${startingWidth + 24}px`);
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain('Using: Guide');
    expect(screen.getByRole('button', { name: /Review Guide for clarity/ })).toBeTruthy();
    fireEvent.change(compose, { target: { value: 'Review this document.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(true));
    expect((server.requests.find(request => request.path === '/api/chat/stream')?.body as { viewContext: unknown }).viewContext)
      .toMatchObject({ readerBlockId: 'guide', editingBlockId: 'guide', selectedBlockIds: ['guide'], editorHasUnsavedChanges: false });

    fireEvent.click(within(editor).getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read Guide full page' }));
    const reader = screen.getByRole('dialog', { name: 'Guide full page' });
    fireEvent.click(within(reader).getByRole('button', { name: 'Ask Symbi' }));
    fireEvent.change(compose, { target: { value: 'Explain this document.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    expect((server.requests.filter(request => request.path === '/api/chat/stream')[1].body as { viewContext: unknown }).viewContext)
      .toMatchObject({ readerBlockId: 'guide', selectedBlockIds: ['guide'] });
  });

  it('refreshes a clean editor after a Symbi edit and protects an unsaved draft', async () => {
    const block: CanvasBlock = { id: 'guide', title: 'Guide', file: 'guide.md', kind: 'markdown', content: '# Guide',
      contentHash: 'first-version', x: 0, y: 0, width: 400, height: 280, links: [] };
    const firstReply = deferred<{ message: string; changed: boolean }>();
    const secondReply = deferred<{ message: string; changed: boolean }>();
    const server = fixture({ initialBlocks: [block], hasApiKey: true,
      chatReplies: [firstReply.promise, secondReply.promise] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Guide' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Ask Symbi' }));
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'Edit this document.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(true));
    server.canvas.blocks[0] = { ...server.canvas.blocks[0], content: '# Better guide', contentHash: 'second-version' };
    firstReply.resolve({ message: 'Updated the guide.', changed: true });
    await waitFor(() => expect(editorText(editor)).toBe('# Better guide'));

    typeInEditor(editor, '# My unsaved draft');
    fireEvent.change(compose, { target: { value: 'Review my changes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    expect((server.requests.filter(request => request.path === '/api/chat/stream')[1].body as { viewContext: unknown }).viewContext)
      .toMatchObject({ editorHasUnsavedChanges: true,
        editorDraft: { title: 'Guide', kind: 'markdown', content: '# My unsaved draft' } });
    server.canvas.blocks[0] = { ...server.canvas.blocks[0], content: '# New saved guide', contentHash: 'third-version' };
    secondReply.resolve({ message: 'Checked the guide.', changed: true });
    await waitFor(() => expect(within(editor).getByText(/The saved document changed while this editor was open/)).toBeTruthy());
    expect(editorText(editor)).toBe('# My unsaved draft');
    expect(within(editor).getByRole('button', { name: 'Save document' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Load saved version' }));
    expect(editorText(editor)).toBe('# New saved guide');
  });

  it('creates a Markdown block, searches it, and opens its editor from the result', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Brainstorm' } });
    expect(editorText(editor)).toContain('# Brainstorm');
    typeInEditor(editor, '# Ideas\n\nFind a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview' }));
    expect(within(editor).getByRole('region', { name: 'Document preview' }).textContent).toContain('Find a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Source' }));
    expect(editorText(editor)).toBe('# Ideas\n\nFind a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull());
    expect(server.canvas.blocks).toMatchObject([{ title: 'Brainstorm', content: '# Ideas\n\nFind a path.' }]);
    await waitFor(() => expect(document.querySelector('.canvas-card.is-highlighted')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    fireEvent.change(within(search).getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Ideas' } });
    expect(within(search).getByRole('status').textContent).toContain('Searching documents…');
    fireEvent.click(await within(search).findByRole('button', { name: 'Edit Brainstorm' }));
    const reopened = await screen.findByRole('dialog', { name: 'Document editor' });
    expect((within(reopened).getByLabelText('Title') as HTMLInputElement).value).toBe('Brainstorm');
    await within(reopened).findByLabelText('Markdown source');
    expect(editorText(reopened)).toContain('Find a path.');
  });

  it('shows a search result on the canvas without opening the editor', async () => {
    const block: CanvasBlock = { id: 'outline', file: 'outline.md', title: 'Outline', kind: 'markdown', content: '# Outline', x: 900, y: 400, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [block] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Outline' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show Outline on canvas' }));
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Search documents' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.canvas-card.is-highlighted')).toBeTruthy());
  });

  it('closes the mobile assistant when revealing a card', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 620px)' }));
    const block: CanvasBlock = { id: 'outline', file: 'outline.md', title: 'Outline', kind: 'markdown', content: '# Outline', x: 900, y: 400, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [block] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Outline' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show Outline on canvas' }));
    await waitFor(() => expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(true));
  });

  it('reports when a search hit has disappeared before it can be revealed', async () => {
    const server = fixture({ searchResults: [{ canvasId: 'planning', blockId: 'missing', title: 'Old note', excerpt: 'Deleted' }] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Old' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show Old note on canvas' }));
    expect(await screen.findByText('This document no longer exists on the canvas.')).toBeTruthy();
    expect(screen.queryByText('Old note is on the canvas')).toBeNull();
  });

  it('opens settings when chat has no key and preserves the unsent message', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'Summarize this canvas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect((compose as HTMLTextAreaElement).value).toBe('Summarize this canvas');
    expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(false);
  });

  it('keeps settings open and shows the server error when saving fails', async () => {
    const server = fixture({ failSettingsSave: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Settings could not be saved')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('creates a workspace and a second canvas from the empty state', async () => {
    const server = fixture({ empty: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    const workspaceDialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(workspaceDialog).getByLabelText('Workspace name'), { target: { value: 'Design team' } });
    fireEvent.click(within(workspaceDialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Untitled canvas' })).toBeTruthy();
    expect(server.workspaces[0]).toMatchObject({ name: 'Design team', canvases: [{ name: 'Untitled canvas' }] });

    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const canvasDialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(canvasDialog).getByLabelText('Canvas name'), { target: { value: 'Launch map' } });
    fireEvent.click(within(canvasDialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Launch map' })).toBeTruthy();
    expect(server.workspaces[0].canvases).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Untitled canvas' }));
    expect(await screen.findByRole('heading', { name: 'Untitled canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    const nextWorkspace = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(nextWorkspace).getByLabelText('Workspace name'), { target: { value: 'Research' } });
    fireEvent.click(within(nextWorkspace).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Untitled canvas' })).toBeTruthy();
    expect(server.workspaces).toHaveLength(2);
  });

  it('uploads Markdown, MDX, and HTML files and reports an unsupported file', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const markdown = new File(['# Brief'], 'Brief.md', { type: 'text/markdown' });
    const mdx = new File(['# Tool\n<Calculator />'], 'Tool.mdx', { type: 'text/markdown' });
    const html = new File(['<main><h1>Hello</h1></main>'], 'Landing.html', { type: 'text/html' });
    Object.defineProperty(markdown, 'text', { value: async () => '# Brief' });
    Object.defineProperty(mdx, 'text', { value: async () => '# Tool\n<Calculator />' });
    Object.defineProperty(html, 'text', { value: async () => '<main><h1>Hello</h1></main>' });
    fireEvent.change(input, { target: { files: [markdown, mdx, html] } });
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(3));
    expect(server.canvas.blocks).toMatchObject([{ title: 'Brief', kind: 'markdown', content: '# Brief' }, { title: 'Tool', kind: 'mdx', content: '# Tool\n<Calculator />' },
      { title: 'Landing', kind: 'markdown', content: '---\nformat: html\n---\n<main><h1>Hello</h1></main>' }]);

    const unsupported = new File(['x'], 'picture.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [unsupported] } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose a .md, .mdx, or .html file: picture.png');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('edits and deletes an existing Markdown file through the search result', async () => {
    const existing: CanvasBlock = { id: 'outline', file: 'outline.md', title: 'Outline', kind: 'markdown', content: '# Old', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [existing] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Outline' } });
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    const editor = await screen.findByRole('dialog', { name: 'Document editor' });
    await within(editor).findByLabelText('Markdown source');
    typeInEditor(editor, '# Revised');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(server.canvas.blocks[0].content).toBe('# Revised'));

    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    const reopened = await screen.findByRole('dialog', { name: 'Document editor' });
    await within(reopened).findByLabelText('Markdown source');
    expect((within(reopened).getByRole('link', { name: 'Download .md' }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/canvases/planning/blocks/outline/download');
    const replacement = new File(['# Edited on disk'], 'outline.md', { type: 'text/markdown' });
    Object.defineProperty(replacement, 'text', { value: async () => '# Edited on disk' });
    fireEvent.change(reopened.querySelector('input[type=file]')!, { target: { files: [replacement] } });
    await waitFor(() => expect(editorText(reopened)).toBe('# Edited on disk'));
    fireEvent.click(within(reopened).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(server.canvas.blocks[0].content).toBe('# Edited on disk'));
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Document editor' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(0));
    expect(server.requests.some(request => request.path.endsWith('/blocks/outline') && request.method === 'DELETE')).toBe(true);
  });

  it('streams chat replies, refreshes canvas content, and retries a failed request without duplicating the user turn', async () => {
    const server = fixture({ hasApiKey: true, chatReplies: [
      { message: 'I updated the roadmap.', changed: true },
      { error: 'OpenRouter unavailable' },
      { message: 'The roadmap is ready.', changed: false },
    ] });
    const fetcher = vi.fn(server.fetchResponse);
    vi.stubGlobal('fetch', fetcher);
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    const send = (message: string) => {
      fireEvent.change(compose, { target: { value: message } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    };
    send('Update roadmap');
    expect(await screen.findByText('I updated the roadmap.')).toBeTruthy();
    const canvasReads = fetcher.mock.calls.filter(([path]) => String(path).startsWith('/api/canvases/planning'));
    expect(canvasReads.map(([path]) => String(path))).toEqual(['/api/canvases/planning?summary=1', '/api/canvases/planning', '/api/canvases/planning?summary=1']);
    expect(canvasReads.every(([, init]) => init?.cache === 'no-store')).toBe(true);
    send('What now?');
    expect((await screen.findByRole('alert')).textContent).toContain('OpenRouter unavailable');
    const failedRequest = server.requests.filter(request => request.path === '/api/chat/stream').at(-1);
    expect(screen.getByText('What now?')).toBeTruthy();
    // The failed turn owns its original request even after the visible context changes.
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' }));
    fireEvent.click(screen.getByRole('button', { name: /^Whole canvas/ }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The roadmap is ready.')).toBeTruthy();
    expect(screen.queryByText('OpenRouter unavailable')).toBeNull();
    const chatRequests = server.requests.filter(request => request.path === '/api/chat/stream');
    expect(chatRequests).toHaveLength(3);
    expect(chatRequests[2].body).toEqual(failedRequest?.body);
    expect(screen.getAllByText('What now?')).toHaveLength(1);
  });

  it('starts a new chat with empty history while keeping the canvas open', async () => {
    const server = fixture({ hasApiKey: true, chatReplies: [
      { message: 'First answer.', changed: false }, { message: 'Second answer.', changed: false },
    ] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('First answer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and start' }));
    expect(screen.queryByText('First answer.')).toBeNull();
    expect(screen.getByText('Hi, I’m Symbi.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Second answer.')).toBeTruthy();
    const requests = server.requests.filter(request => request.path === '/api/chat/stream');
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toMatchObject({ messages: [{ role: 'user', content: 'Second question' }] });
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeTruthy();
  });

  it('starts an empty chat after a generated research action without replaying that action', async () => {
    window.localStorage.setItem('symbiknow:research-session', JSON.stringify({
      turns: [{ id: 2, query: 'Original question', answer: 'Research answer', sources: [], status: 'complete',
        patch: { query: 'Original question', blocks: [{ id: 'seed', type: 'text', title: 'Seed block',
          content: 'Research body', sourceIds: [] }, { id: 'second', type: 'text', title: 'Second block', content: 'Second body', sourceIds: [] }], edges: [] } }],
      edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'mindmap',
    }));
    const server = fixture({ hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open research canvas' }));
    const cards = within(await screen.findByRole('region', { name: 'Research canvas' }));
    fireEvent.click(cards.getByRole('button', { name: 'Step 1: Seed block' }));
    const first = await cards.findByText('Seed block', { selector: '.canvas-card__identity strong' });
    const second = await cards.findByText('Second block', { selector: '.canvas-card__identity strong' });
    fireEvent.click(first.closest('.react-flow__pane') ?? document.querySelector('.answer-canvas .react-flow__pane')!);
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    for (const title of [first, second]) fireEvent.keyDown(title.closest('.react-flow__node')!, { key: 'Enter', code: 'Enter', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Control' });
    fireEvent.click(await cards.findByRole('button', { name: 'AI: summarize these' }));
    expect(await screen.findByText('Canvas summarized.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and start' }));
    expect(screen.getByText('Hi, I’m Symbi.')).toBeTruthy();
    expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1);
    expect(screen.queryByText(/Summarize these research blocks/)).toBeNull();
  });

  it.each(['another canvas', 'a new editor', 'a closed editor'] as const)(
    'ignores a pending Search Edit response after switching to %s', async destination => {
      const block: CanvasBlock = { id: 'old-note', title: 'Old note', kind: 'markdown', content: '# Old note',
        file: 'old-note.md', contentHash: 'aaaaaaaaaaaaaaaa', x: 0, y: 0, width: 320, height: 240, links: [] };
      const server = fixture({ initialBlocks: [block] });
      server.workspaces[0].canvases.push({ id: 'other', name: 'Other' });
      server.canvases.set('other', { id: 'other', name: 'Other', workspaceId: 'team', blocks: [] });
      const pending = deferred<Response>();
      let holdRead = false;
      let requested = false;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/canvases/planning?summary=1' && holdRead) {
          holdRead = false; requested = true;
          return pending.promise;
        }
        return server.fetchResponse(input, init);
      }));
      render(<App/>);
      expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Search documents' }));
      const search = screen.getByRole('dialog', { name: 'Search documents' });
      fireEvent.change(within(search).getByRole('textbox', { name: 'Search every Markdown file' }), { target: { value: 'Old' } });
      const edit = await within(search).findByRole('button', { name: 'Edit Old note' });
      holdRead = true;
      fireEvent.click(edit);
      expect(requested).toBe(true);
      if (destination === 'another canvas') {
        fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Other' }));
        expect(await screen.findByRole('heading', { name: 'Other' })).toBeTruthy();
      } else {
        fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
        expect(screen.getByRole('heading', { name: 'New document' })).toBeTruthy();
        if (destination === 'a closed editor') fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
      }
      await act(async () => pending.resolve(Response.json(server.canvas)));
      if (destination === 'a new editor') {
        expect(screen.getByRole('heading', { name: 'New document' })).toBeTruthy();
        expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Untitled note');
      } else expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Edit document' })).toBeNull();
    });

  it('restores temporary research after refresh and asks before clearing it', async () => {
    window.localStorage.setItem('symbiknow:research-session', JSON.stringify({
      turns: [{ id: 12, query: 'What changed?', answer: 'The plan changed.', sources: [], status: 'working' }],
      edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'mindmap',
    }));
    const server = fixture({ hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open research canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('alertdialog', { name: 'Start a new chat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(screen.getByRole('button', { name: 'Open research canvas' })).toBeTruthy();
  });

  it('asks for a canvas before sending a chat request', async () => {
    const server = fixture({ empty: true, hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Open a canvas before using the assistant.');
    expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(false);
  });

  it('shows a readable chat error when a stream fails with an unknown value', async () => {
    const server = fixture({ hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/chat/stream') return new Response(new ReadableStream({ start(controller) { controller.error('connection lost'); } }));
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Please try again.');
  });

  it('reports a canvas refresh failure after a completed assistant reply', async () => {
    const server = fixture({ hasApiKey: true, failCanvasAfterFirst: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Summarize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Canvas summarized.')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas unavailable');
  });

  it('stops an in-flight assistant response and prevents duplicate sends', async () => {
    const server = fixture({ hasApiKey: true });
    let resolveResponse!: (response: Response) => void;
    let chatSignal!: AbortSignal;
    let chatRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/chat/stream') {
        chatRequests++;
        chatSignal = init!.signal as AbortSignal;
        return new Promise<Response>(resolve => { resolveResponse = resolve; });
      }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = screen.getByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'First request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.change(compose, { target: { value: 'Second request' } });
    fireEvent.submit(compose.closest('form')!);
    expect(chatRequests).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(chatSignal.aborted).toBe(true);
    resolveResponse(new Response('data: [DONE]\n\n'));
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(within(document.querySelector('.ai-chat__messages') as HTMLElement).queryByText('Second request')).toBeNull();
    expect(server.requests.filter(request => request.path === '/api/canvases/planning')).toHaveLength(1);
  });

  it('switches a new block loader, preserves edited source, and closes dialogs with Escape', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(editor).getByLabelText('Loader'), { target: { value: 'slides' } });
    expect(editorText(editor)).toContain('# New presentation');
    typeInEditor(editor, '# Custom');
    fireEvent.change(within(editor).getByLabelText('Loader'), { target: { value: 'mdx' } });
    expect(editorText(editor)).toBe('# Custom');
    fireEvent.keyDown(editor, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();

    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Document editor' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Search documents' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'absent' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search every Markdown file…'), { key: 'a' });
    expect(await screen.findByText('No matching documents.')).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText('Search every Markdown file…'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(true);
  });

  it('checks a Markdown task and shows a recoverable error if the document cannot be saved', async () => {
    const task: CanvasBlock = { id: 'tasks', file: 'tasks.md', title: 'Tasks', kind: 'markdown', content: '# Tasks\n- [ ] Review', x: 10, y: 20, width: 350, height: 250, links: [] };
    const note: CanvasBlock = { id: 'note', file: 'note.md', title: 'Note', kind: 'markdown', content: '# Note', x: 390, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [task, note] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    const checkbox = await screen.findByRole('checkbox', {}, { timeout: 5000 });
    fireEvent.click(checkbox);
    await waitFor(() => expect(server.canvas.blocks[0].content).toContain('- [x] Review'));
    expect(server.requests.some(request => request.path.endsWith('/blocks/tasks') && request.method === 'PUT')).toBe(true);

    cleanup();
    const failing = fixture({ initialBlocks: [task], failBlockUpdate: true });
    vi.stubGlobal('fetch', vi.fn(failing.fetchResponse));
    render(<App/>);
    fireEvent.click(await screen.findByRole('checkbox'));
    expect(await screen.findByText(/Could not save checkbox: Document could not be saved/)).toBeTruthy();
    expect(failing.canvas.blocks[0].content).toContain('- [ ] Review');
  });

  it('shows search and canvas load errors while keeping navigation available', async () => {
    const server = fixture({ failSearch: true, failCanvas: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Canvas unavailable');
    expect(screen.getByRole('heading', { name: 'Loading canvas…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    fireEvent.change(within(search).getByPlaceholderText('Search every Markdown file…'), { target: { value: 'roadmap' } });
    await waitFor(() => expect(within(search).getByRole('alert').textContent).toContain('Search unavailable'));
    fireEvent.click(within(search).getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
  });

  it('guides new canvas creation when no workspace exists', async () => {
    const server = fixture({ empty: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(dialog).getByLabelText('Canvas name'), { target: { value: 'Cannot create' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Create a workspace first.');
    expect(screen.getByRole('dialog', { name: 'Create new' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Create new' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create new' })).toBeNull();
  });

  it('uses assistant suggestions, keyboard send, and the assistant settings shortcut', async () => {
    const server = fixture({ hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Help me plan this canvas/ }));
    expect(await screen.findByText('Canvas summarized.')).toBeTruthy();
    expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1);
    const compose = screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement;
    fireEvent.change(compose, { target: { value: 'Find connections between these documents' } });
    fireEvent.keyDown(compose, { key: 'Enter', shiftKey: true });
    expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1);
    fireEvent.keyDown(compose, { key: 'Enter' });
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });

  it('grows one conversation canvas across follow-ups and preserves the original documents', async () => {
    const block: CanvasBlock = { id: 'qa', title: 'Mobile QA report', file: 'qa.md', kind: 'markdown',
      content: '# Mobile QA\n\nTwo launch tests failed.', x: 100, y: 100, width: 380, height: 240, links: [] };
    const answerCanvas: AnswerCanvasResult = { canvasId: 'planning', query: 'What blocks launch?', selection: 'jev', sources: [
      { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: block.title,
        excerpt: 'Two launch tests failed.', relevance: .9 },
    ] };
    const researchPatch: ResearchCanvasPatch = { query: answerCanvas.query, layout: 'architecture', blocks: [
      { id: 'summary', type: 'text', title: 'Launch summary', content: 'Two tests failed.', sourceIds: ['planning:qa'] },
      { id: 'flow', type: 'diagram', title: 'Release flow', content: '```mermaid\nflowchart LR\nQA-->Release\n```', sourceIds: ['planning:qa'] },
      { id: 'next', type: 'task', title: 'Next actions', content: '- [ ] Re-run QA', sourceIds: [] },
    ], edges: [{ from: 'summary', to: 'flow', label: 'explains' }, { from: 'flow', to: 'next', label: 'unblocks' }] };
    const server = fixture({ hasApiKey: true, initialBlocks: [block], answerCanvas, researchPatch });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: answerCanvas.query } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    const board = await screen.findByRole('region', { name: 'Research canvas' });
    expect(within(board).getByText(/3 documents · 1 cited source/)).toBeTruthy();
    expect((server.requests.find(request => request.path === '/api/chat/stream')?.body as { viewContext: unknown }).viewContext)
      .toMatchObject({ selectedBlockIds: [], viewMode: 'documents' });
    fireEvent.click(within(board).getByRole('button', { name: 'Return to main canvas' }));
    expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull();
    fireEvent.change(compose, { target: { value: 'Which tests failed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull();
    fireEvent.click(screen.getByTitle('Open research canvas'));
    expect(within(screen.getByRole('region', { name: 'Research canvas' })).getByText(/6 documents · 1 cited source/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Research canvas' })).getByRole('button', { name: 'Save canvas' }));
    await waitFor(() => expect(server.canvases.size).toBe(2));
    const saved = [...server.canvases.values()].find(item => item.id !== 'planning')!;
    await waitFor(() => expect(saved.blocks).toHaveLength(6));
    expect(saved.blocks[0].content).toContain('## Sources');
    expect(saved.blocks[0].content).toContain('Mobile QA report');
    expect(saved.blocks[0].links).toContain(saved.blocks[1].id);
    expect(server.canvas.blocks[0]).toMatchObject({ x: 100, y: 100, content: block.content });
  });

  it('keeps a later direct chat answer out of the existing research canvas', async () => {
    const source: AnswerCanvasResult = { canvasId: 'planning', query: 'Map the launch risks', selection: 'jev', surface: 'canvas', sources: [
      { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Two failures', relevance: 1 },
    ] };
    const patch: ResearchCanvasPatch = { query: source.query, layout: 'mindmap', blocks: [
      { id: 'risk', type: 'text', title: 'Launch risk', content: 'Two tests failed.', sourceIds: ['planning:qa'] },
      { id: 'impact', type: 'text', title: 'Impact', content: 'Release is delayed.', sourceIds: ['planning:qa'] },
    ], edges: [{ from: 'risk', to: 'impact', label: 'causes' }] };
    const server = fixture({ hasApiKey: true, answerCanvas: source, researchPatch: patch, canvasReplyIndices: [1],
      initialBlocks: [{ id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: 'Two failures', x: 100, y: 100, width: 300, height: 180, links: [] }],
      chatReplies: [{ message: 'Mapped.', changed: false }, { message: 'The two mobile tests failed.', changed: false }] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: source.query } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    const board = await screen.findByRole('region', { name: 'Research canvas' });
    expect(within(board).getByText(/2 documents/)).toBeTruthy();
    fireEvent.click(within(board).getByRole('button', { name: 'Return to main canvas' }));
    fireEvent.change(compose, { target: { value: 'Which tests failed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('The two mobile tests failed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas' }));
    const reopened = screen.getByRole('region', { name: 'Research canvas' });
    expect(within(reopened).getByText(/2 documents/)).toBeTruthy();
    expect(within(reopened).queryByRole('navigation', { name: 'Research questions' })).toBeNull();
    expect(within(reopened).getByText('Answer outline · 2 steps')).toBeTruthy();
  });

  it('returns to the research canvas after the agent navigates to a cited document', async () => {
    const block: CanvasBlock = { id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: 'Two failures',
      x: 100, y: 100, width: 300, height: 180, links: [] };
    const answerCanvas: AnswerCanvasResult = { canvasId: 'planning', query: 'Map launch risks', selection: 'jev', surface: 'canvas', sources: [
      { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Two failures', relevance: 1 },
    ] };
    const patch: ResearchCanvasPatch = { query: 'Map launch risks', layout: 'mindmap', blocks: [
      { id: 'risk', type: 'text', title: 'Launch risk', content: 'Two failures', sourceIds: ['planning:qa'] },
    ], edges: [] };
    const server = fixture({ hasApiKey: true, initialBlocks: [block], answerCanvas, researchPatch: patch,
      canvasReplyIndices: [1], navigationReplyIndices: [2],
      chatNavigation: { kind: 'document', canvasId: 'planning', blockId: 'qa', title: 'QA report' } });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = await screen.findByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'Map launch risks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('region', { name: 'Research canvas' });
    fireEvent.change(compose, { target: { value: 'Show the QA report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));
    expect(await screen.findByRole('region', { name: 'Research canvas' })).toBeTruthy();
  });

  it('opens the upload chooser and closes the docked search and modal', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Upload files' }));
    expect(click).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    fireEvent.mouseDown(search);
    expect(screen.getByRole('dialog', { name: 'Search documents' })).toBeTruthy();
    fireEvent.click(within(search).getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.mouseDown(settings);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.mouseDown(settings.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });

  it('closes search when a result points to a deleted block', async () => {
    const server = fixture({ searchResults: [{ canvasId: 'planning', blockId: 'deleted', title: 'Deleted note', excerpt: 'Old text' }] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Deleted' } });
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Deleted note' }));
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();
  });

  it('shows an initial workspace error and allows a fresh workspace action', async () => {
    const server = fixture({ failWorkspaces: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Workspace unavailable');
    expect(screen.getByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(screen.getByRole('dialog', { name: 'Create new' })).toBeTruthy();
  });

  it('reports an error when a search result canvas becomes unavailable', async () => {
    const existing: CanvasBlock = { id: 'outline', file: 'outline.md', title: 'Outline', kind: 'markdown', content: '# Outline', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [existing], failCanvasAfterFirst: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Outline' } });
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Canvas unavailable');
    expect(screen.queryByRole('dialog', { name: 'Document editor' })).toBeNull();
  });

  it('refreshes the active canvas after a WebMCP tool creates a document', async () => {
    const registered = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    class TestWebMCP {
      registerTool(name: string, _description: string, _schema: unknown, execute: (args: Record<string, unknown>) => Promise<unknown>) { registered.set(name, execute); }
      registerResource() {}
    }
    vi.stubGlobal('WebMCP', TestWebMCP);
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    await waitFor(() => expect(registered.has('upload_file')).toBe(true));
    const before = server.requests.filter(request => request.path === '/api/canvases/planning').length;
    await registered.get('upload_file')?.({ mode: 'create', filename: 'note.md', idempotencyKey: 'app-note', title: 'MCP note', content: '# From WebMCP' });
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/canvases/planning').length).toBe(before + 1));
    expect(server.canvas.blocks[0]).toMatchObject({ title: 'MCP note', content: '# From WebMCP' });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/canvases/planning?summary=1' && !init?.method) return Response.json({ error: 'Canvas unavailable' }, { status: 503 });
      return server.fetchResponse(input, init);
    }));
    await registered.get('upload_file')?.({ mode: 'create', filename: 'followup.md', idempotencyKey: 'app-followup', title: 'MCP follow-up', content: '# Follow-up' });
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas unavailable');

    cleanup();
    const empty = fixture({ empty: true });
    vi.stubGlobal('fetch', vi.fn(empty.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    await registered.get('upload_file')?.({ mode: 'create', filename: 'offscreen.md', idempotencyKey: 'app-offscreen', canvasId: 'planning', title: 'Offscreen MCP note', content: '# Offscreen' });
    expect(empty.canvas.blocks[0].title).toBe('Offscreen MCP note');
    expect(screen.getByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
  });

  it('shows a readable error when the initial network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'offline'; }));
    render(<App/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas server is unavailable. Check that it is running, then retry.');
    expect(screen.getByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
  });

  it('reconnects from the error banner when the canvas server returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<App/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas server is unavailable');
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    expect(screen.queryByText('Canvas server is unavailable. Check that it is running, then retry.')).toBeNull();
  });

  it('undoes a document just created by the agent and reads back the canvas', async () => {
    const pending = deferred<{ message: string; changed: boolean }>();
    const server = fixture({ hasApiKey: true, chatReplies: [pending.promise] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = screen.getByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'Create a launch note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(true));
    server.canvas.blocks.push({ id: 'launch-note', title: 'Launch note', file: 'launch-note.md', kind: 'markdown',
      content: '# Launch note', x: 100, y: 100, width: 300, height: 180, links: [] });
    await act(async () => pending.resolve({ message: 'Created the note.', changed: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo creation' }));
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(0));
    expect(await screen.findByText('Undid creation of Launch note.')).toBeTruthy();
  });

  it('undoes an agent edit but refuses to overwrite a later edit', async () => {
    const original: CanvasBlock = { id: 'qa', title: 'QA report', file: 'qa.md', kind: 'markdown', content: 'Original result',
      x: 100, y: 100, width: 300, height: 180, links: [] };
    const first = deferred<{ message: string; changed: boolean }>();
    const second = deferred<{ message: string; changed: boolean }>();
    const server = fixture({ hasApiKey: true, initialBlocks: [original], chatReplies: [first.promise, second.promise] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = screen.getByRole('textbox', { name: 'Message Symbi' });
    fireEvent.change(compose, { target: { value: 'Update QA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1));
    server.canvas.blocks[0].content = 'Agent result';
    await act(async () => first.resolve({ message: 'Updated QA.', changed: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo edit' }));
    await waitFor(() => expect(server.canvas.blocks[0].content).toBe('Original result'));
    fireEvent.change(compose, { target: { value: 'Update QA again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    server.canvas.blocks[0].content = 'Agent result two';
    await act(async () => second.resolve({ message: 'Updated QA again.', changed: true }));
    const undo = await screen.findByRole('button', { name: 'Undo edit' });
    server.canvas.blocks[0].content = 'Teammate result';
    fireEvent.click(undo);
    expect((await screen.findByRole('alert')).textContent).toContain('changed again');
    expect(server.canvas.blocks[0].content).toBe('Teammate result');
  });

  it('keeps the conversation when the user changes canvases while a reply finishes', async () => {
    let resolveReply!: (value: { message: string; changed: boolean }) => void;
    const pending = new Promise<{ message: string; changed: boolean }>(resolve => { resolveReply = resolve; });
    const server = fixture({ hasApiKey: true, chatReplies: [pending] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(dialog).getByLabelText('Canvas name'), { target: { value: 'Second canvas' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Planning' }));
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Second canvas' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    resolveReply({ message: 'Prior canvas reply', changed: true });
    expect(await screen.findByText('Prior canvas reply')).toBeTruthy();
    expect(screen.getByText('Status?')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    expect(screen.queryByText('Assistant is thinking')).toBeNull();
  });

  it('ignores an initial workspace response after the App unmounts', async () => {
    const first = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/workspaces' ? first.promise : Response.json({ provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: false })));
    render(<App/>);
    cleanup();
    first.resolve(Response.json([initialWorkspace]));
    await first.promise;
    expect(screen.queryByRole('heading', { name: 'Planning' })).toBeNull();

    const second = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/workspaces' ? second.promise : Response.json({ provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: false })));
    render(<App/>);
    cleanup();
    second.reject(new Error('late failure'));
    await expect(second.promise).rejects.toThrow('late failure');
  });

  it('ignores an obsolete canvas load failure after switching canvases', async () => {
    const pending = deferred<Response>();
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/canvases/planning?summary=1' ? pending.promise : server.fetchResponse(input, init)));
    render(<App/>);
    expect(await screen.findByRole('button', { name: 'New canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(dialog).getByLabelText('Canvas name'), { target: { value: 'Second canvas' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    pending.reject(new Error('stale canvas failure'));
    await expect(pending.promise).rejects.toThrow('stale canvas failure');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the selected canvas when a delayed block edit finishes on the previous canvas', async () => {
    const task: CanvasBlock = { id: 'tasks', file: 'tasks.md', title: 'Tasks', kind: 'markdown', content: '# Tasks\n- [ ] Review', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [task] });
    const pending = deferred<void>();
    let updateStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/blocks/tasks') && init?.method === 'PUT') { updateStarted = true; await pending.promise; }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('checkbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const dialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(dialog).getByLabelText('Canvas name'), { target: { value: 'Second canvas' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Planning' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(updateStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Second canvas' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(server.canvas.blocks[0].content).toContain('- [x] Review'));
    expect(screen.getByRole('heading', { name: 'Second canvas' })).toBeTruthy();
  });

  it('does not show an old canvas when a delayed new block save finishes after navigation', async () => {
    const server = fixture();
    const pending = deferred<void>();
    let saveStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/canvases/planning/blocks' && init?.method === 'POST') { saveStarted = true; await pending.promise; }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New canvas' }));
    const create = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(create).getByLabelText('Canvas name'), { target: { value: 'Second canvas' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Planning' }));
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
    const editor = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Delayed note' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save document' }));
    await waitFor(() => expect(saveStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: Second canvas' }));
    expect(await screen.findByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(1));
    expect(screen.getByRole('heading', { name: 'Second canvas' })).toBeTruthy();
    expect(screen.queryByText('Delayed note')).toBeNull();
  });

  it('keeps an in-progress settings dialog open when Escape is pressed', async () => {
    const pending = deferred<void>();
    const server = fixture();
    let saveStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/settings' && init?.method === 'PUT') { saveStarted = true; await pending.promise; }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saveStarted).toBe(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
  });

  it('rejects empty form names and titles before creating files', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(within(document.querySelector<HTMLElement>('.topbar')!).getByRole('button', { name: 'Create note' }));
    const blockDialog = screen.getByRole('dialog', { name: 'Document editor' });
    fireEvent.change(within(blockDialog).getByLabelText('Title'), { target: { value: ' ' } });
    fireEvent.submit(within(blockDialog).getByRole('button', { name: 'Save document' }).closest('form')!);
    expect(server.requests.some(request => request.path.endsWith('/blocks') && request.method === 'POST')).toBe(false);
    fireEvent.click(within(blockDialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    const workspaceDialog = screen.getByRole('dialog', { name: 'Create new' });
    fireEvent.change(within(workspaceDialog).getByLabelText('Workspace name'), { target: { value: ' ' } });
    fireEvent.submit(within(workspaceDialog).getByRole('button', { name: 'Create' }).closest('form')!);
    expect(server.workspaces).toHaveLength(1);
  });

  it('persists a block deleted from the canvas with the Delete key', async () => {
    const block: CanvasBlock = { id: 'draft', file: 'draft.md', title: 'Draft', kind: 'markdown', content: '# Draft', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [block] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const node = await waitFor(() => {
      const found = document.querySelector('.react-flow__node') as HTMLElement | null;
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(node);
    fireEvent.keyDown(document, { key: 'Delete' });
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(0));
    expect(server.requests.some(request => request.path.endsWith('/blocks/draft') && request.method === 'DELETE')).toBe(true);
  });

  it('reports a failed Delete-key persistence request and retains the block', async () => {
    const block: CanvasBlock = { id: 'draft', file: 'draft.md', title: 'Draft', kind: 'markdown', content: '# Draft', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [block], failBlockDelete: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const node = await waitFor(() => {
      const found = document.querySelector('.react-flow__node') as HTMLElement | null;
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(node);
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(await screen.findByText('Could not delete: Document could not be deleted')).toBeTruthy();
    expect(server.canvas.blocks).toHaveLength(1);
  });

  it('ignores stale search results and failures after the query changes', async () => {
    const freshBlock: CanvasBlock = {
      id: 'fresh', file: 'fresh.md', title: 'Fresh note', kind: 'markdown', content: '# Fresh note\nCurrent result',
      x: 10, y: 20, width: 350, height: 250, links: [],
    };
    const server = fixture({ initialBlocks: [freshBlock] });
    const stale = deferred<Response>();
    const failure = deferred<Response>();
    let staleStarted = false;
    let failureStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/search?q=stale') { staleStarted = true; return stale.promise; }
      if (path === '/api/search?q=bad') { failureStarted = true; return failure.promise; }
      if (path === '/api/search?q=fresh') return Response.json([{ canvasId: 'planning', blockId: 'fresh', title: 'Fresh note', excerpt: 'Current result' }]);
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    const input = screen.getByPlaceholderText('Search every Markdown file…');
    fireEvent.change(input, { target: { value: 'stale' } });
    await waitFor(() => expect(staleStarted).toBe(true));
    fireEvent.change(input, { target: { value: 'fresh' } });
    stale.resolve(Response.json([{ canvasId: 'planning', blockId: 'old', title: 'Stale note', excerpt: 'Outdated' }]));
    expect(await screen.findByRole('button', { name: 'Edit Fresh note' })).toBeTruthy();
    expect(screen.queryByText('Stale note')).toBeNull();

    fireEvent.change(input, { target: { value: 'bad' } });
    await waitFor(() => expect(failureStarted).toBe(true));
    fireEvent.change(input, { target: { value: 'fresh' } });
    failure.reject(new Error('stale search failure'));
    await expect(failure.promise).rejects.toThrow('stale search failure');
    expect(await screen.findByRole('button', { name: 'Edit Fresh note' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('handles empty uploads and a non-Error file read failure', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: null } });
    const broken = new File(['x'], 'broken.md', { type: 'text/markdown' });
    Object.defineProperty(broken, 'text', { value: async () => { throw 'read failed'; } });
    fireEvent.change(input, { target: { files: [broken] } });
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Please try again.');
    expect(server.canvas.blocks).toHaveLength(0);
  });

  it('finishes an upload safely after its input unmounts', async () => {
    const server = fixture();
    const content = deferred<string>();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['# Note'], 'note.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: () => content.promise });
    fireEvent.change(input, { target: { files: [file] } });
    cleanup();
    content.resolve('# Note');
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(1));
  });
});
