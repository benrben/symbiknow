import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createApiServer } from '../server/index';
import type { AnswerCanvasTurn } from '../shared/answer-canvas';
import type { CanvasDocument, WorkspaceSummary } from '../shared/types';
import { App } from './App';
import { installCanvasBrowser } from './canvas-model.test.helpers';
import { researchStorageKey } from './app-state-helpers';
import { emptyResearchEdits } from './research-edits';

const nativeFetch = globalThis.fetch;
const opened: { server: Server; root: string }[] = [];
export const turn: AnswerCanvasTurn = { id: 1, query: 'Release evidence', answer: 'The release needs review.', sources: [], status: 'complete', patch: {
  query: 'Release evidence', blocks: [{ id: 'release', type: 'text', title: 'Release review', content: 'Review before release.', sourceIds: [] }], edges: [],
} };
export function storedResearch() {
  return JSON.parse(localStorage.getItem(researchStorageKey) ?? 'null') as { turns: AnswerCanvasTurn[] };
}
export function installAssistantBrowser() {
  installCanvasBrowser();
  beforeEach(() => {
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', '');
    vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
    window.history.replaceState(null, '', '/');
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllEnvs();
    for (const { server, root } of opened.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // Native inbox/cache work may finish its final atomic rename as the
      // server closes; filesystem cleanup retries that transient collision.
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 20 });
    }
  });
}
export type Network = (route: string, init: RequestInit, forward: () => Promise<Response>) => Promise<Response>;
type Prepare = (request: (route: string, init?: RequestInit) => Promise<Response>, root: string) => Promise<void>;
export async function assistantFixture(network?: Network, research = true, prepare?: Prepare, providers: Omit<Parameters<typeof createApiServer>[0], 'dataDir'> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-assistant-'));
  const server = await createApiServer({ dataDir: root, ...providers });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  opened.push({ server, root });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing API fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, init?: RequestInit) => nativeFetch(base + route, init);
  await prepare?.(request, root);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const route = String(input).replace('?summary=1', '');
    const forward = () => request(String(input), init);
    return network ? network(route, init, forward) : forward();
  });
  if (research) localStorage.setItem(researchStorageKey, JSON.stringify({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' }));
  // Load the installed lazy views before mounting; module transformation is a
  // test-runner concern, while the public UI still owns every mount and event.
  await import('./AIElementsChat');
  const view = render(<App />);
  await screen.findByRole('button', { name: 'New chat' });
  await screen.findByRole('textbox', { name: 'Message Symbi' });
  await screen.findByText('Product Roadmap', { selector: '.canvas-label h1' });
  return {
    ...view, root, request,
    async documents() { return request('/api/workspaces').then(response => response.json()) as Promise<WorkspaceSummary[]>; },
    async read(id: string) { return request('/api/canvases/' + id).then(response => response.json()) as Promise<CanvasDocument>; },
    async disk() { return JSON.parse(await readFile(path.join(root, 'workspaces.json'), 'utf8')) as { workspaces: WorkspaceSummary[] }; },
  };
}
export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
export function heldSave() {
  const queued: (() => Promise<Response>)[] = [];
  const waiting: ((response: Response) => void)[] = [];
  const network: Network = (route, init, forward) => {
    if (init.method !== 'POST' || !/\/workspaces\/[^/]+\/canvases$/.test(route)) return forward();
    queued.push(forward);
    return new Promise<Response>(resolve => waiting.push(resolve));
  };
  return {
    network, get count() { return queued.length; },
    async release(index = 0, response?: Response) {
      await act(async () => waiting[index](response ?? await queued[index]()));
    },
  };
}
export async function confirmNewChat() {
  await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
  return screen.findByRole('alertdialog', { name: 'Start a new chat' });
}
export async function completedResearchSave(fixture: Awaited<ReturnType<typeof assistantFixture>>) {
  await waitFor(async () => expect((await fixture.documents()).flatMap(workspace => workspace.canvases).some(document => document.name === 'Research — Release evidence')).toBe(true));
  const saved = (await fixture.documents()).flatMap(workspace => workspace.canvases).find(document => document.name === 'Research — Release evidence');
  if (!saved) throw new Error('Research save did not persist');
  await waitFor(async () => expect((await fixture.read(saved.id)).blocks).toHaveLength(1));
  await screen.findByRole('button', { name: 'Open canvas: ' + saved.name });
  return saved;
}
