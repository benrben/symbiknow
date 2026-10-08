// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answer, fixture } from '../server/chat-session.test.fixture';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { AIElementsChat } from './AIElementsChat';
import { sameDocument } from './canvas-changes';
import type { AIElementsChatProps } from './chat-types';

const nativeFetch = globalThis.fetch;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function send(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
}

async function holdCompletedRead(response: Response, hold: Promise<void>, entered: () => void) {
  // The HTTP read has finished; cancellation can still precede the async consumer's continuation.
  const body = await response.arrayBuffer();
  entered(); await hold;
  return new Response(body, { status: response.status, headers: response.headers });
}

function recordRequest(route: string, init: RequestInit | undefined,
  requests: Array<{ canvasId: string; viewContext: unknown; messages: unknown }>,
  reads: Array<{ route: string; cache?: RequestCache }>) {
  if (route === '/api/chat/stream') requests.push(JSON.parse(String(init?.body)));
  if (route.startsWith('/api/canvases/')) reads.push({ route, cache: init?.cache });
}

it.each([
  { mode: 'no write after a repaired baseline read', retryWrites: false, cancelRead: false },
  { mode: 'actual retry write and safe Undo', retryWrites: true, cancelRead: false },
  { mode: 'cancelled baseline read', retryWrites: false, cancelRead: true },
])('replays native failed intent with a fresh original-canvas receipt baseline: $mode', async ({ retryWrites, cancelRead }) => {
  const f = await fixture(); const base = await f.app();
  const other = await f.store.createCanvas(f.canvas.workspaceId, { name: 'Later canvas' });
  let attempts = 0;
  f.model.handle = async (_request, response) => {
    if (attempts++ === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Native provider declined once', type: 'invalid_request_error' } }));
    } else {
      if (retryWrites && attempts === 2) {
        const written = await nativeFetch(`${base}/api/canvases/${f.canvas.id}/blocks/${f.canvas.blocks[0].id}`, {
          method: 'PUT', headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Retry agent' },
          body: JSON.stringify({ content: '# Saved by the actual retry attempt' }),
        });
        expect(written.ok).toBe(true);
      }
      answer(response, ['Native reply recovered.']);
    }
  };
  const requests: Array<{ canvasId: string; viewContext: unknown; messages: unknown }> = [];
  const reads: Array<{ route: string; cache?: RequestCache }> = [];
  let releaseRead!: () => void; let enteredRead!: () => void;
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const readEntered = new Promise<void>(resolve => { enteredRead = resolve; });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    recordRequest(String(input), init, requests, reads);
    const response = await nativeFetch(new URL(String(input), base), init);
    if (cancelRead && String(input) === `/api/canvases/${f.canvas.id}`) return holdCompletedRead(response, heldRead, enteredRead);
    return response;
  });
  const onCanvasChanged = vi.fn(async (id: string, before: CanvasBlock[]) => {
    const current = await nativeFetch(`${base}/api/canvases/${id}`).then(response => response.json()) as CanvasDocument;
    const known = new Map(before.map(block => [block.id, block]));
    return { created: current.blocks.filter(block => !known.has(block.id)), updated: current.blocks.flatMap(after => {
      const previous = known.get(after.id);
      return previous && !sameDocument(previous, after) ? [{ before: previous, after }] : [];
    }) };
  });
  const props: AIElementsChatProps = {
    canvasId: f.canvas.id, canvas: f.canvas, viewContext: { selectedBlockIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
    answerTurns: [], hasApiKey: true, model: f.settings.model, onCanvasChanged,
    onOpenSettings: vi.fn(), onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(),
    onUndoCreatedBlock: vi.fn(), onUndoEditedBlock: async (canvasId, edit) => {
      const restored = await nativeFetch(`${base}/api/canvases/${canvasId}/jev/undo-parent`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'edited', before: edit.before, after: edit.after }),
      });
      expect(restored.ok).toBe(true);
    }, onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(),
    onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn(),
  };
  const originalBlocks = structuredClone(f.canvas.blocks);
  const view = render(<AIElementsChat {...props} />);
  send('Keep the original native request');
  expect((await screen.findByRole('alert')).textContent).toContain('OpenAI-compatible request failed (400)');
  const originalRequest = structuredClone(requests[0]);
  const before = originalBlocks[0];
  const edited = await f.store.updateBlock(f.canvas.id, before.id, { content: '# Saved external agent evidence' }, 'External agent');
  const refreshed = await f.store.getCanvas(f.canvas.id);
  // Refreshing the caller's sources cannot alter intent; its changes must not become retry Undo receipts.
  f.canvas.blocks.splice(0, f.canvas.blocks.length, ...refreshed.blocks);
  props.viewContext.viewport!.x = 500;
  const nextProps = { ...props, canvasId: other.id, canvas: other,
    viewContext: { selectedBlockIds: [], viewport: { x: 300, y: 200, zoom: .4 } } };
  view.rerender(<AIElementsChat {...nextProps} />);
  if (!retryWrites && !cancelRead) {
    const file = path.join(f.root, 'canvases', f.canvas.id + '.json'); const saved = await readFile(file, 'utf8');
    await writeFile(file, '{interrupted native canvas metadata');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Internal server error');
    expect(requests).toHaveLength(1); expect(onCanvasChanged).not.toHaveBeenCalled();
    expect(screen.getAllByText('Keep the original native request')).toHaveLength(1);
    await writeFile(file, saved);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  if (cancelRead) {
    await readEntered;
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => { releaseRead(); });
    expect(requests).toHaveLength(1); expect(onCanvasChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect((await f.store.getCanvasBlock(f.canvas.id, before.id)).content).toBe(edited.content);
    return;
  }
  await screen.findByText('Native reply recovered.');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  expect(requests[1]).toEqual(originalRequest);
  expect(screen.getAllByText('Keep the original native request')).toHaveLength(1);
  expect(reads).toEqual(Array.from({ length: retryWrites ? 1 : 2 }, () => ({ route: `/api/canvases/${f.canvas.id}`, cache: 'no-store' })));
  expect(onCanvasChanged).toHaveBeenCalledWith(f.canvas.id, JSON.parse(JSON.stringify(refreshed.blocks)));
  const changes = await onCanvasChanged.mock.results[0].value;
  if (retryWrites) {
    expect(changes.updated).toHaveLength(1);
    expect(changes.updated[0].before.content).toBe(edited.content);
    expect(changes.updated[0].before.contentHash).toBe(edited.contentHash);
    expect(changes.updated[0].after.content).toBe('# Saved by the actual retry attempt');
    fireEvent.click(screen.getByText('Review changes to ' + before.title));
    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }));
    await waitFor(() => expect(screen.getByText('Undid edit to ' + before.title + '.')).toBeTruthy());
  } else {
    expect(changes).toEqual({ created: [], updated: [] });
    expect(screen.queryByText('Review changes to ' + before.title)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo edit' })).toBeNull();
  }
  expect((await f.store.getCanvasBlock(f.canvas.id, before.id)).content).toBe(edited.content);
  send('Use the later native canvas');
  await waitFor(() => expect(requests).toHaveLength(3));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  expect(requests[2]).toMatchObject({ canvasId: other.id, viewContext: nextProps.viewContext });
  expect(onCanvasChanged).toHaveBeenLastCalledWith(other.id, other.blocks);
});
