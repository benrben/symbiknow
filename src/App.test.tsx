// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { App } from './App';
import type { CanvasBlock, CanvasDocument, ChatSettings, WorkspaceSummary } from '../shared/types';
import type { InsightItem, InsightReport } from '../shared/insights';
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
  hasJevApiKey?: boolean;
  chatReplies?: Array<{ message: string; changed: boolean } | { error: string } | Promise<{ message: string; changed: boolean } | { error: string }>>;
  answerCanvas?: AnswerCanvasResult;
  researchPatch?: ResearchCanvasPatch;
  canvasReplyIndices?: number[];
  navigationReplyIndices?: number[];
  chatNavigation?: CanvasNavigationTarget;
  failCanvas?: boolean;
  failSearch?: boolean;
  failBlockUpdate?: boolean;
  failBlockDelete?: boolean;
  searchResults?: Array<{ canvasId: string; blockId: string; title: string; excerpt: string }>;
  failWorkspaces?: boolean;
  failCanvasAfterFirst?: boolean;
  insightsReport?: InsightReport;
  duplicatesReport?: Array<InsightItem & { canvasIds: [string, string] }>;
  failLayout?: boolean;
  failAutomation?: boolean;
} = {}) {
  const workspaces = options.empty ? [] : [structuredClone(initialWorkspace)];
  const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: structuredClone(options.initialBlocks ?? []) };
  const canvases = new Map<string, CanvasDocument>([[canvas.id, canvas]]);
  let settings: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: options.hasApiKey ?? false, hasJevApiKey: options.hasJevApiKey ?? false, reviewers: '' };
  const requests: { path: string; method: string; body: unknown }[] = [];
  let chatIndex = 0;
  let canvasReads = 0;
  let lastMerge: { canvasId: string; before: CanvasBlock[] } | null = null;

  const fetchResponse = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestPath = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ path: requestPath, method, body });
    if (requestPath === '/api/workspaces' && method === 'GET') {
      if (options.failWorkspaces) return Response.json({ error: 'Workspace unavailable' }, { status: 503 });
      return Response.json(workspaces);
    }
    if (requestPath === '/api/workspaces' && method === 'POST') {
      const created: WorkspaceSummary = { id: 'new-team-' + (workspaces.length + 1), name: String(body?.name), canvases: [] };
      workspaces.push(created);
      return Response.json(created);
    }
    if (requestPath === '/api/settings' && method === 'GET') return Response.json(settings);
    if (requestPath === '/api/settings' && method === 'PUT') {
      if (options.failSettingsSave) return Response.json({ error: 'Settings could not be saved' }, { status: 503 });
      settings = { ...settings, model: String(body?.model), systemPrompt: String(body?.systemPrompt), reviewers: String(body?.reviewers), agentProfile: body?.agentProfile as ChatSettings['agentProfile'], agentPlugins: body?.agentPlugins as ChatSettings['agentPlugins'], hasApiKey: Boolean(body?.apiKey) || settings.hasApiKey, hasJevApiKey: Boolean(body?.jevApiKey) || settings.hasJevApiKey };
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
    const insightsRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/insights$/);
    if (insightsRoute && method === 'POST') return Response.json({ ...options.insightsReport, canvasId: insightsRoute[1], query: String(body?.query ?? '') });
    const duplicatesRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/duplicates$/);
    if (duplicatesRoute && method === 'POST') return Response.json(options.duplicatesReport ?? []);
    const feedbackRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/insights\/feedback$/);
    if (feedbackRoute && method === 'POST') return Response.json({ ok: true });
    const mergeRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/merge$/);
    if (mergeRoute && method === 'POST') {
      const document = canvases.get(mergeRoute[1]);
      const keeper = document?.blocks.find(block => block.id === body?.keepBlockId);
      if (!document || !keeper) return Response.json({ error: 'Merge document missing' }, { status: 404 });
      const ids = body?.mergeBlockIds as string[];
      const hashes = body?.expectedContentHashes as Record<string, string>;
      if ([keeper.id, ...ids].some(id => document.blocks.find(block => block.id === id)?.contentHash !== hashes[id])) {
        return Response.json({ error: 'A merge document changed. Review the proposed merge again.' }, { status: 409 });
      }
      lastMerge = { canvasId: mergeRoute[1], before: structuredClone(document.blocks) };
      keeper.content = String(body?.content);
      document.blocks.forEach(block => { if (ids.includes(block.id)) block.archived = true; });
      return Response.json({ mergeId: 'merge-1', keepBlockId: keeper.id, archivedBlockIds: ids, contentHash: 'merged-hash' });
    }
    if (requestPath === '/api/merges/merge-1/undo' && method === 'POST') {
      if (!lastMerge) return Response.json({ error: 'Merge not found' }, { status: 404 });
      const document = canvases.get(lastMerge.canvasId)!;
      document.blocks = lastMerge.before;
      lastMerge = null;
      return Response.json({ mergeId: 'merge-1', reverted: true });
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
    const automationRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/automations$/);
    if (automationRoute && method === 'POST') {
      if (options.failAutomation) return Response.json({ error: 'Jev is unavailable' }, { status: 502 });
      const document = canvases.get(automationRoute[1])!;
      const kind = String(body?.kind);
      if (kind === 'layout') {
        document.blocks.forEach((block, index) => Object.assign(block, { x: 80 + index * 558, y: 80, group: index ? 'area:sales' : 'area:frontend' }));
        return Response.json({ kind, applied: 1, groupBy: body?.groupBy, groups: document.blocks.map(block => ({ key: block.group, count: 1 })) });
      }
      if (kind === 'connection') document.blocks[0].links = document.blocks[0].links.length ? [] : [document.blocks[1].id];
      if (kind === 'purpose') document.blocks[0].purpose = 'guide';
      if (kind === 'reviewer') document.blocks[0].reviewer = 'Engineering';
      return Response.json({ kind, applied: 1 });
    }
    const blocksRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/blocks$/);
    if (blocksRoute && method === 'POST') {
      const document = canvases.get(blocksRoute[1]);
      if (!document) return Response.json({ error: 'Canvas missing' }, { status: 404 });
      const id = String(body?.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const block: CanvasBlock = {
        id, file: id + '.md', title: String(body?.title), kind: body?.kind as CanvasBlock['kind'], content: String(body?.content),
        x: Number(body?.x ?? 100), y: Number(body?.y ?? 100), width: 350, height: 250, links: [],
      };
      document.blocks.push(block);
      return Response.json(block);
    }
    const blockRoute = requestPath.match(/^\/api\/canvases\/([^/]+)\/blocks\/([^/]+)$/);
    if (blockRoute) {
      const document = canvases.get(blockRoute[1]);
      const block = document?.blocks.find(item => item.id === blockRoute[2]);
      if (!document || !block) return Response.json({ error: 'Block missing' }, { status: 404 });
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
    if (requestPath === '/api/chat/intents' && method === 'POST') return Response.json({ token: 'merge-intent', expiresAt: '2026-09-26T20:00:00.000Z' }, { status: 201 });
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
  it('shows a cached canvas immediately and revalidates it with an ETag on return', async () => {
    const server = fixture();
    server.workspaces[0].canvases.push({ id: 'research', name: 'Research' });
    server.canvases.set('research', { id: 'research', name: 'Research', workspaceId: 'team', blocks: [] });
    const conditionalReads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const match = path.match(/^\/api\/canvases\/(planning|research)$/);
      if (match) {
        const etag = new Headers(init?.headers).get('If-None-Match');
        if (etag) {
          conditionalReads.push(`${match[1]}:${etag}`);
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        const response = await server.fetchResponse(input, init);
        return new Response(await response.text(), { status: response.status,
          headers: { 'content-type': 'application/json', ETag: `"${match[1]}-v1"` } });
      }
      return server.fetchResponse(input, init);
    }));
    render(<App/>);
    expect(await screen.findByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    expect(await screen.findByRole('region', { name: 'Research infinite canvas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Planning' }));
    expect(screen.getByRole('region', { name: 'Planning infinite canvas' })).toBeTruthy();
    expect(screen.queryByText('Loading canvas…')).toBeNull();
    await waitFor(() => expect(conditionalReads).toContain('planning:"planning-v1"'));
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

    fireEvent.click(screen.getByRole('button', { name: 'Toggle AI assistant' }));
    expect(document.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(false);
  });

  it('uses the empty canvas to introduce shared knowledge and start a document', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Make knowledge together.' })).toBeTruthy();
    expect(screen.getByText(/team and its AI agents can connect, organize, and build on it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add your first block' }));
    expect(screen.getByRole('dialog', { name: 'Block editor' })).toBeTruthy();
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
    fireEvent.change(within(settingsDialog).getByLabelText(/^TypeSafe Jev API key/), { target: { value: 'jev-secret' } });
    fireEvent.change(within(settingsDialog).getByLabelText('System prompt'), { target: { value: 'Be concise.' } });
    fireEvent.change(within(settingsDialog).getByLabelText(/^Review teams/), { target: { value: 'Product, Engineering' } });
    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(await screen.findByText('anthropic/claude-sonnet-4', {}, { timeout: 5000 })).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-or-v1-secret');
    expect(document.body.textContent).not.toContain('jev-secret');
    expect(server.requests.find(request => request.path === '/api/settings' && request.method === 'PUT')?.body)
      .toMatchObject({ model: 'anthropic/claude-sonnet-4', apiKey: 'sk-or-v1-secret', jevApiKey: 'jev-secret', systemPrompt: 'Be concise.', reviewers: 'Product, Engineering' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getAllByText('Connected')).toHaveLength(2);
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
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Edit documents/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(server.requests.find(request => request.path === '/api/settings' && request.method === 'PUT')?.body)
      .toMatchObject({ agentProfile: 'planner', agentPlugins: ['document_read', 'jev_insights', 'tasks', 'external_mcp'] });
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

  it('creates a Markdown block, searches it, and opens its editor from the result', async () => {
    const server = fixture();
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const editor = screen.getByRole('dialog', { name: 'Block editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Brainstorm' } });
    expect(editorText(editor)).toContain('# Brainstorm');
    typeInEditor(editor, '# Ideas\n\nFind a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview' }));
    expect(within(editor).getByRole('region', { name: 'Document preview' }).textContent).toContain('Find a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Source' }));
    expect(editorText(editor)).toBe('# Ideas\n\nFind a path.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull());
    expect(server.canvas.blocks).toMatchObject([{ title: 'Brainstorm', content: '# Ideas\n\nFind a path.' }]);
    await waitFor(() => expect(document.querySelector('.canvas-card.is-highlighted')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    fireEvent.change(within(search).getByPlaceholderText('Search every Markdown file…'), { target: { value: 'Ideas' } });
    expect(within(search).getByText('Searching documents…')).toBeTruthy();
    fireEvent.click(await within(search).findByRole('button', { name: 'Edit Brainstorm' }));
    const reopened = await screen.findByRole('dialog', { name: 'Block editor' });
    expect((within(reopened).getByLabelText('Title') as HTMLInputElement).value).toBe('Brainstorm');
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
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Toggle AI assistant' }));
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

    const compose = await screen.findByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    fireEvent.click(screen.getByRole('button', { name: /Untitled canvas/ }));
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
    const editor = await screen.findByRole('dialog', { name: 'Block editor' });
    await within(editor).findByLabelText('Markdown source');
    typeInEditor(editor, '# Revised');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(server.canvas.blocks[0].content).toBe('# Revised'));

    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    const reopened = await screen.findByRole('dialog', { name: 'Block editor' });
    await within(reopened).findByLabelText('Markdown source');
    expect((within(reopened).getByRole('link', { name: 'Download .md' }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/canvases/planning/blocks/outline/download');
    const replacement = new File(['# Edited on disk'], 'outline.md', { type: 'text/markdown' });
    Object.defineProperty(replacement, 'text', { value: async () => '# Edited on disk' });
    fireEvent.change(reopened.querySelector('input[type=file]')!, { target: { files: [replacement] } });
    await waitFor(() => expect(editorText(reopened)).toBe('# Edited on disk'));
    fireEvent.click(within(reopened).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(server.canvas.blocks[0].content).toBe('# Edited on disk'));
    fireEvent.click(screen.getByRole('button', { name: /Search documents/ }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Search documents' })).findByRole('button', { name: 'Edit Outline' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Block editor' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(0));
    expect(server.requests.some(request => request.path.endsWith('/blocks/outline') && request.method === 'DELETE')).toBe(true);
  });

  it('streams chat replies, refreshes canvas content, and retries a failed request without duplicating the user turn', async () => {
    const server = fixture({ hasApiKey: true, chatReplies: [
      { message: 'I updated the roadmap.', changed: true },
      { error: 'OpenRouter unavailable' },
      { message: 'The roadmap is ready.', changed: false },
    ] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
    const send = (message: string) => {
      fireEvent.change(compose, { target: { value: message } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    };
    send('Update roadmap');
    expect(await screen.findByText('I updated the roadmap.')).toBeTruthy();
    expect(server.requests.filter(request => request.path === '/api/canvases/planning')).toHaveLength(2);
    send('What now?');
    expect((await screen.findByRole('alert')).textContent).toContain('OpenRouter unavailable');
    const failedRequest = server.requests.filter(request => request.path === '/api/chat/stream').at(-1);
    expect(screen.getByText('What now?')).toBeTruthy();
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'First question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('First answer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('First answer.')).toBeNull();
    expect(screen.getByText('Build knowledge together')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Second answer.')).toBeTruthy();
    const requests = server.requests.filter(request => request.path === '/api/chat/stream');
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toMatchObject({ messages: [{ role: 'user', content: 'Second question' }] });
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeTruthy();
  });

  it('asks for a canvas before sending a chat request', async () => {
    const server = fixture({ empty: true, hasApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Hello' } });
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Please try again.');
  });

  it('reports a canvas refresh failure after a completed assistant reply', async () => {
    const server = fixture({ hasApiKey: true, failCanvasAfterFirst: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Summarize' } });
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
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const editor = screen.getByRole('dialog', { name: 'Block editor' });
    fireEvent.change(within(editor).getByLabelText('Loader'), { target: { value: 'slides' } });
    expect(editorText(editor)).toContain('# New presentation');
    typeInEditor(editor, '# Custom');
    fireEvent.change(within(editor).getByLabelText('Loader'), { target: { value: 'mdx' } });
    expect(editorText(editor)).toBe('# Custom');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Block editor' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Search documents' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search every Markdown file…'), { target: { value: 'absent' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search every Markdown file…'), { key: 'a' });
    expect(await screen.findByText('No matching documents.')).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText('Search every Markdown file…'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle AI assistant' }));
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
    await waitFor(() => expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Search unavailable'));
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
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }) as HTMLTextAreaElement;
    fireEvent.change(compose, { target: { value: 'Find connections between these documents' } });
    fireEvent.keyDown(compose, { key: 'Enter', shiftKey: true });
    expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1);
    fireEvent.keyDown(compose, { key: 'Enter' });
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Assistant settings' }));
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
    const server = fixture({ hasApiKey: true, hasJevApiKey: true, initialBlocks: [block], answerCanvas, researchPatch });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    expect(within(reopened).getByRole('navigation', { name: 'Research questions' }).querySelectorAll('button')).toHaveLength(1);
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
    const compose = await screen.findByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
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
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();
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
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();
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
    await waitFor(() => expect(registered.has('create_doc')).toBe(true));
    const before = server.requests.filter(request => request.path === '/api/canvases/planning').length;
    await registered.get('create_doc')?.({ title: 'MCP note', content: '# From WebMCP' });
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/canvases/planning').length).toBe(before + 1));
    expect(server.canvas.blocks[0]).toMatchObject({ title: 'MCP note', content: '# From WebMCP' });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/canvases/planning' && !init?.method) return Response.json({ error: 'Canvas unavailable' }, { status: 503 });
      return server.fetchResponse(input, init);
    }));
    await registered.get('create_doc')?.({ title: 'MCP follow-up', content: '# Follow-up' });
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas unavailable');

    cleanup();
    const empty = fixture({ empty: true });
    vi.stubGlobal('fetch', vi.fn(empty.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'One infinite canvas for people and AI' })).toBeTruthy();
    await registered.get('create_doc')?.({ canvasId: 'planning', title: 'Offscreen MCP note', content: '# Offscreen' });
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
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    const compose = screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Planning' }));
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/chat/stream')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Second canvas' }));
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/canvases/planning' ? pending.promise : server.fetchResponse(input, init)));
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
    fireEvent.click(screen.getByRole('button', { name: 'Planning' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(updateStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Second canvas' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Planning' }));
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const editor = screen.getByRole('dialog', { name: 'Block editor' });
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Delayed note' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(saveStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Second canvas' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const blockDialog = screen.getByRole('dialog', { name: 'Block editor' });
    fireEvent.change(within(blockDialog).getByLabelText('Title'), { target: { value: ' ' } });
    fireEvent.submit(within(blockDialog).getByRole('button', { name: 'Save block' }).closest('form')!);
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
    const server = fixture();
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

  it('applies Jev metadata, edge, and layout suggestions to the saved canvas', async () => {
    const blocks: CanvasBlock[] = [
      { id: 'alpha', file: 'alpha.md', title: 'Alpha', kind: 'markdown', content: '# Alpha', x: 10, y: 20, width: 350, height: 250, links: [] },
      { id: 'beta', file: 'beta.md', title: 'Beta', kind: 'markdown', content: '# Beta', x: 60, y: 70, width: 350, height: 250, links: [] },
    ];
    const report: InsightReport = {
      canvasId: 'planning', query: '', analyzed: 2, total: 2,
      readingOrder: [{ blockId: 'alpha', title: 'Alpha', score: 0.9, confidence: 0.9 }],
      relevance: [{ blockId: 'beta', title: 'Beta', score: 0.8, confidence: 0.9 }],
      items: [
        { id: 'purpose', category: 'purpose', title: 'Label Alpha', detail: 'Name its role.', blockIds: ['alpha'], confidence: 0.9,
          action: { type: 'update', blockId: 'alpha', patch: { purpose: 'guide', reviewer: 'Engineering' } } },
        { id: 'edge', category: 'connection', title: 'Connect documents', detail: 'Add a link.', blockIds: ['alpha', 'beta'], confidence: 0.9,
          action: { type: 'link', fromBlockId: 'alpha', toBlockId: 'beta' } },
        { id: 'layout', category: 'layout', title: 'Arrange canvas', detail: 'Place related documents together.', blockIds: ['alpha', 'beta'], confidence: 0.9,
          action: { type: 'layout', positions: [{ blockId: 'alpha', x: 200, y: 300 }, { blockId: 'beta', x: 600, y: 300 }] } },
      ],
    };
    const server = fixture({ initialBlocks: blocks, hasJevApiKey: true, insightsReport: report });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze canvas' }));
    expect(await screen.findByText('Label Alpha')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Suggested reading order' })).getByRole('button', { name: 'Open Alpha' })).toBeTruthy();
    fireEvent.click(within(screen.getByText('Label Alpha').closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.canvas.blocks[0]).toMatchObject({ purpose: 'guide', reviewer: 'Engineering' }));
    fireEvent.click(within(screen.getByRole('heading', { name: 'Connect documents' }).closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.canvas.blocks[0].links).toContain('beta'));
    fireEvent.click(within(screen.getByText('Arrange canvas').closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.canvas.blocks.map(block => [block.x, block.y])).toEqual([[200, 300], [600, 300]]));
    expect(server.requests.some(request => request.path === '/api/canvases/planning/layout' && request.method === 'PUT')).toBe(true);
    fireEvent.click(within(screen.getByRole('region', { name: 'Suggested reading order' })).getByRole('button', { name: 'Open Alpha' }));
    expect(screen.getByRole('dialog', { name: 'Alpha full page' })).toBeTruthy();
  });

  it('drafts a merge in preview chat and applies only the reviewed Markdown with source hashes', async () => {
    const blocks: CanvasBlock[] = [
      { id: 'guide', file: 'guide.md', title: 'Guide', kind: 'markdown', content: '# Guide\nOld step', contentHash: 'hash-guide', x: 10, y: 20, width: 350, height: 250, links: [] },
      { id: 'notes', file: 'notes.md', title: 'Notes', kind: 'markdown', content: '# Notes\nUnique step', contentHash: 'hash-notes', x: 60, y: 70, width: 350, height: 250, links: [] },
    ];
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 2, total: 2, readingOrder: [], relevance: [], items: [
      { id: 'merge', category: 'merge', title: 'Merge Guide and Notes', detail: 'Keep both steps.', blockIds: ['guide', 'notes'], confidence: 0.92,
        action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['notes'], plan: { keep: 'Guide', fold: ['Unique step'], conflicts: [], drop: [] } } },
    ] };
    const server = fixture({ initialBlocks: blocks, hasApiKey: true, hasJevApiKey: true, insightsReport: report,
      chatReplies: [{ message: 'Proposed merge:\n```markdown\n# Guide\nOld step\nUnique step\n```', changed: false }] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    fireEvent.click(within((await screen.findByText('Merge Guide and Notes')).closest('article')!).getByRole('button', { name: 'Merge in chat' }));
    const review = await screen.findByRole('dialog', { name: 'Review merge draft' });
    expect(server.requests.find(request => request.path === '/api/chat/intents')?.body).toEqual({ canvasId: 'planning', action: 'merge documents', blockIds: ['guide', 'notes'] });
    expect(server.requests.find(request => request.path === '/api/chat/stream')?.body).toMatchObject({ previewMerge: true, intentToken: 'merge-intent' });
    expect(server.requests.some(request => request.path === '/api/canvases/planning/merge')).toBe(false);
    expect(within(review).getByRole('region', { name: 'Proposed changes' }).textContent).toContain('+ Unique step');
    expect(within(review).getByText('Notes')).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: 'Apply merge' }));
    await waitFor(() => expect(server.requests.some(request => request.path === '/api/canvases/planning/merge')).toBe(true));
    const request = server.requests.find(entry => entry.path === '/api/canvases/planning/merge');
    expect(request?.body).toEqual({ keepBlockId: 'guide', mergeBlockIds: ['notes'], content: '# Guide\nOld step\nUnique step',
      expectedContentHashes: { guide: 'hash-guide', notes: 'hash-notes' } });
    await waitFor(() => expect(server.canvas.blocks.find(block => block.id === 'notes')?.archived).toBe(true));
    expect(server.requests).toContainEqual(expect.objectContaining({ path: '/api/canvases/planning/insights/feedback',
      body: { itemId: 'merge', category: 'merge', confidence: 0.92, decision: 'applied' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo merge' }));
    await waitFor(() => expect(server.canvas.blocks.find(block => block.id === 'notes')?.archived).toBeUndefined());
    expect(server.canvas.blocks.find(block => block.id === 'guide')?.content).toBe('# Guide\nOld step');
    expect(server.requests).toContainEqual(expect.objectContaining({ path: '/api/merges/merge-1/undo', method: 'POST' }));
  });

  it('moves a suggested document to another canvas and reloads the source', async () => {
    const block: CanvasBlock = { id: 'guide', file: 'guide.md', title: 'Guide', kind: 'markdown', content: '# Guide', x: 10, y: 20, width: 350, height: 250, links: [] };
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 1, total: 1, readingOrder: [], relevance: [], items: [
      { id: 'move', category: 'move', title: 'Move Guide', detail: 'Better in Reference.', blockIds: ['guide'], confidence: 0.86,
        action: { type: 'move', blockId: 'guide', toCanvasId: 'reference' } },
    ] };
    const server = fixture({ initialBlocks: [block], hasJevApiKey: true, insightsReport: report });
    server.canvases.set('reference', { id: 'reference', name: 'Reference', workspaceId: 'team', blocks: [] });
    server.workspaces[0].canvases.push({ id: 'reference', name: 'Reference' });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    fireEvent.click(within((await screen.findByText('Move Guide')).closest('article')!).getByRole('button', { name: 'Move document' }));
    await waitFor(() => expect(server.canvas.blocks).toHaveLength(0));
    expect(server.canvases.get('reference')?.blocks.map(item => item.id)).toEqual(['guide']);
    expect(server.requests).toContainEqual(expect.objectContaining({ path: '/api/canvases/planning/blocks/guide/move', method: 'POST', body: { targetCanvasId: 'reference' } }));
  });

  it('drafts a missing document in chat and follows a named reading path', async () => {
    const blocks: CanvasBlock[] = ['guide', 'plan', 'aside'].map((id, index) => ({ id, file: `${id}.md`, title: id[0].toUpperCase() + id.slice(1), kind: 'markdown', content: `# ${id}`, x: index * 400, y: 0, width: 350, height: 250, links: [] }));
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 3, total: 3, readingOrder: [], relevance: [],
      readingPaths: [{ id: 'path', name: 'Onboarding', blockIds: ['guide', 'plan'] }], items: [
        { id: 'gap', category: 'gap', title: 'Document the API', detail: 'Missing API guide.', blockIds: ['guide'], confidence: 0.8 },
      ] };
    const server = fixture({ initialBlocks: blocks, hasApiKey: true, hasJevApiKey: true, insightsReport: report });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    fireEvent.click(within((await screen.findByText('Document the API')).closest('article')!).getByRole('button', { name: 'Draft it in chat' }));
    await waitFor(() => expect(server.requests.some(request => request.path === '/api/chat/stream')).toBe(true));
    const chatRequest = server.requests.find(request => request.path === '/api/chat/stream');
    expect(chatRequest?.body).not.toHaveProperty('previewMerge');
    expect(JSON.stringify(chatRequest?.body)).toContain('Document the API');
    expect(JSON.stringify(chatRequest?.body)).toContain('relation prerequisite');
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start path' }));
    const reader = await screen.findByRole('dialog', { name: 'Guide full page' });
    expect(within(reader).getByRole('navigation', { name: 'Reading path: Onboarding' })).toBeTruthy();
    expect(within(reader).getByText('1 / 2')).toBeTruthy();
    fireEvent.click(within(reader).getByRole('button', { name: 'Next document' }));
    expect(await screen.findByRole('dialog', { name: 'Plan full page' })).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });

  it('opens targeted duplicate results from a canvas card and explains cross-canvas merge limits', async () => {
    const block: CanvasBlock = { id: 'guide', file: 'guide.md', title: 'Guide', kind: 'markdown', content: '# Guide', x: 10, y: 20, width: 350, height: 250, links: [] };
    const server = fixture({ initialBlocks: [block], hasJevApiKey: true, duplicatesReport: [
      { id: 'across', category: 'merge', title: 'Guide and Other Guide overlap', detail: 'Review both.', blockIds: ['guide', 'other'], canvasIds: ['planning', 'reference'], confidence: 0.91,
        action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['other'], plan: { keep: 'guide', fold: [], conflicts: [], drop: [] } } },
    ] });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Guide' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find duplicates of this document' }));
    await screen.findByText('Guide and Other Guide overlap');
    expect(server.requests).toContainEqual(expect.objectContaining({ path: '/api/canvases/planning/duplicates', method: 'POST', body: { crossCanvas: false, blockId: 'guide' } }));
    expect(screen.getByText('This pair spans canvases. Move the documents onto one canvas before merging.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge in chat' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include other canvases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find duplicates' }));
    await waitFor(() => expect(server.requests).toContainEqual(expect.objectContaining({ path: '/api/canvases/planning/duplicates', method: 'POST', body: { crossCanvas: true, blockId: 'guide' } })));
  });

  it('stores a typed supersedes link, marks the target stale, and prunes the type on unlink', async () => {
    const blocks: CanvasBlock[] = [
      { id: 'new', file: 'new.md', title: 'New guide', kind: 'markdown', content: '# New', x: 10, y: 20, width: 350, height: 250, links: [] },
      { id: 'old', file: 'old.md', title: 'Old guide', kind: 'markdown', content: '# Old', x: 60, y: 70, width: 350, height: 250, links: [] },
    ];
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 2, total: 2, readingOrder: [], relevance: [], items: [
      { id: 'supersedes', category: 'supersedes', title: 'New guide supersedes Old guide', detail: 'Mark the older guide stale.', blockIds: ['new', 'old'], confidence: 0.9,
        action: { type: 'link', fromBlockId: 'new', toBlockId: 'old', relation: 'supersedes' } },
      { id: 'unlink', category: 'connection', title: 'Remove old link', detail: 'Remove the relationship.', blockIds: ['new', 'old'], confidence: 0.9,
        action: { type: 'unlink', fromBlockId: 'new', toBlockId: 'old' } },
    ] };
    const server = fixture({ initialBlocks: blocks, hasJevApiKey: true, insightsReport: report });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    await screen.findByRole('heading', { name: 'Planning' });
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));

    fireEvent.click(within((await screen.findByText('New guide supersedes Old guide')).closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.canvas.blocks[0]).toMatchObject({ links: ['old'], linkTypes: { old: 'supersedes' } }));
    await waitFor(() => expect(server.canvas.blocks[1].stale).toBe(true));

    fireEvent.click(within(screen.getByText('Remove old link').closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.canvas.blocks[0]).toMatchObject({ links: [], linkTypes: {} }));
  });

  it('shows a failed layout suggestion and leaves positions unchanged', async () => {
    const block: CanvasBlock = { id: 'alpha', file: 'alpha.md', title: 'Alpha', kind: 'markdown', content: '# Alpha', x: 10, y: 20, width: 350, height: 250, links: [] };
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 1, total: 1, readingOrder: [], relevance: [], items: [
      { id: 'layout', category: 'layout', title: 'Arrange canvas', detail: 'Try a new position.', blockIds: ['alpha'], confidence: 0.9,
        action: { type: 'layout', positions: [{ blockId: 'alpha', x: 200, y: 300 }] } },
    ] };
    const server = fixture({ initialBlocks: [block], hasJevApiKey: true, insightsReport: report, failLayout: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    fireEvent.click(within((await screen.findByText('Arrange canvas')).closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Layout could not be saved'))).toBe(true));
    expect(server.canvas.blocks[0]).toMatchObject({ x: 10, y: 20 });
  });

  it('rejects links to documents removed since analysis and ignores missing document shortcuts', async () => {
    const block: CanvasBlock = { id: 'alpha', file: 'alpha.md', title: 'Alpha', kind: 'markdown', content: '# Alpha', x: 10, y: 20, width: 350, height: 250, links: [] };
    const report: InsightReport = { canvasId: 'planning', query: '', analyzed: 1, total: 1,
      readingOrder: [], relevance: [], items: [
        { id: 'missing-source', category: 'connection', title: 'Missing source', detail: 'Old suggestion.', blockIds: ['missing'], confidence: 0.9,
          action: { type: 'link', fromBlockId: 'missing', toBlockId: 'alpha' } },
        { id: 'missing-target', category: 'connection', title: 'Missing target', detail: 'Old suggestion.', blockIds: ['alpha', 'missing'], confidence: 0.9,
          action: { type: 'link', fromBlockId: 'alpha', toBlockId: 'missing' } },
      ] };
    const server = fixture({ initialBlocks: [block], hasJevApiKey: true, insightsReport: report });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    const source = (await screen.findByText('Missing source')).closest('article')!;
    fireEvent.click(within(source).getByRole('button', { name: 'missing' }));
    expect(screen.queryByRole('dialog', { name: 'Block editor' })).toBeNull();
    fireEvent.click(within(source).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('A linked document no longer exists'))).toBe(true));
    fireEvent.click(within(screen.getByText('Missing target').closest('article')!).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(server.requests.filter(request => request.path === '/api/canvases/planning' && request.method === 'GET')).toHaveLength(3));
    expect(server.requests.some(request => request.path.endsWith('/blocks/alpha') && request.method === 'PUT')).toBe(false);
  });

  it('runs Jev canvas-wide buttons as single server automations and reloads the canvas', async () => {
    const blocks: CanvasBlock[] = [
      { id: 'alpha', file: 'alpha.md', title: 'Alpha', kind: 'markdown', content: '# Alpha', x: 10, y: 20, width: 350, height: 250, links: [] },
      { id: 'beta', file: 'beta.md', title: 'Beta', kind: 'markdown', content: '# Beta', x: 60, y: 70, width: 350, height: 250, links: [] },
    ];
    const server = fixture({ initialBlocks: blocks, hasJevApiKey: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    const run = async (name: string, status: string) => {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(status));
      await waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false));
    };
    await run('Organize positions', 'Placed 2 documents in 2 groups.');
    expect(server.canvas.blocks.map(block => [block.x, block.group])).toEqual([[80, 'area:frontend'], [638, 'area:sales']]);
    await run('Connect documents', 'Applied 1 connection change across this canvas.');
    expect(server.canvas.blocks[0].links).toEqual(['beta']);
    await run('Connect documents', 'Applied 1 connection change across this canvas.');
    expect(server.canvas.blocks[0].links).toEqual([]);
    await run('Label purposes', 'Applied 1 purpose label across this canvas.');
    await run('Assign reviewers', 'Applied 1 reviewer assignment across this canvas.');
    expect(server.canvas.blocks[0]).toMatchObject({ purpose: 'guide', reviewer: 'Engineering' });
    const automations = server.requests.filter(request => request.path === '/api/canvases/planning/automations');
    expect(automations.map(request => request.body)).toEqual([{ kind: 'layout', groupBy: 'work_area' }, { kind: 'connection' }, { kind: 'connection' }, { kind: 'purpose' }, { kind: 'reviewer' }]);
    expect(server.requests.some(request => request.path === '/api/canvases/planning/insights')).toBe(false);
    const dashboard = screen.getByRole('region', { name: 'Document groups' });
    await waitFor(() => expect(within(dashboard).getByText('Frontend')).toBeTruthy());
  });

  it('reports a failed automation and keeps the buttons usable', async () => {
    const blocks: CanvasBlock[] = [
      { id: 'alpha', file: 'alpha.md', title: 'Alpha', kind: 'markdown', content: '# Alpha', x: 10, y: 20, width: 350, height: 250, links: [] },
    ];
    const server = fixture({ initialBlocks: blocks, hasJevApiKey: true, failAutomation: true });
    vi.stubGlobal('fetch', vi.fn(server.fetchResponse));
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regroup & connect' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Jev is unavailable'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Regroup & connect' })).toHaveProperty('disabled', false);
  });
});
