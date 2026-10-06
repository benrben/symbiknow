import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { CanvasStore } from '../server/storage';
import { createApiServer } from '../server/index';
import type { CanvasDocument } from '../shared/types';

const nativeFetch = globalThis.fetch;
const opened: Array<{ root: string; servers: Server[]; drain: () => Promise<void> }> = [];
export type ApiCall = { route: string; method: string; body: Record<string, unknown> };

function base(server: Server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
  return `http://127.0.0.1:${address.port}`;
}
async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return base(server);
}
function requestCall(route: string, init: RequestInit = {}): ApiCall {
  return { route, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
}

function observeApiWork(server: Server) {
  const [handler] = server.listeners('request') as Array<(request: IncomingMessage, response: ServerResponse) => Promise<void>>;
  const work: Promise<void>[] = [];
  server.removeListener('request', handler);
  // A disconnected socket can close before the real handler finishes its cache write.
  // Observe its original promise so teardown waits for the application's actual work.
  server.on('request', (request, response) => { work.push(handler.call(server, request, response)); });
  return async () => {
    let settled = 0;
    while (settled < work.length) {
      const batch = work.slice(settled); settled = work.length;
      await Promise.all(batch);
    }
  };
}

export async function workspaceFixture(providers: Omit<Parameters<typeof createApiServer>[0], 'dataDir'> = {}) {
  vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', ''); vi.stubEnv('ALLTEAM_ACCESS_TOKEN', '');
  localStorage.clear();
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-workspace-native-'));
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Workspace Alpha' });
  const secondWorkspace = await store.createWorkspace({ name: 'Workspace Beta' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Alpha guides' });
  const secondCanvas = await store.createCanvas(secondWorkspace.id, { name: 'Beta guides' });
  await store.createBlock(canvas.id, { title: 'Release guide', content: '# Release guide\nRead the deployment checklist before releasing the service.' });
  await store.createBlock(canvas.id, { title: 'Deployment checklist', content: '# Deployment checklist\nFollow this checklist when using the release guide.' });
  const apiServer = await createApiServer({ dataDir: root, ...providers });
  const drain = observeApiWork(apiServer);
  const apiBase = await listen(apiServer);
  opened.push({ root, servers: [apiServer], drain });
  // State reads deliberately remain nonblocking during startup. Wait through the
  // real configuration boundary before exposing this isolated fixture to the UI.
  const ready = await nativeFetch(`${apiBase}/api/workspaces/${workspace.id}/jev/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!ready.ok) throw new Error(`Native workspace startup failed: ${ready.status}`);
  const calls: ApiCall[] = [];
  const gates: Array<{ route: string; method: string; arrived: (response: Response) => void; wait: Promise<Response> }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { route, method, body } = requestCall(String(input), init);
    calls.push({ route, method, body });
    const gateIndex = gates.findIndex(gate => gate.route === route.split('?')[0] && gate.method === method);
    const gate = gateIndex < 0 ? undefined : gates.splice(gateIndex, 1)[0];
    const response = await nativeFetch(route.startsWith('/api/') ? apiBase + route : input, init);
    if (!gate) return response;
    gate.arrived(response.clone());
    return gate.wait;
  });
  function hold(route: string, method = 'POST') {
    let arrived!: (response: Response) => void; let release!: (response: Response) => void;
    const response = new Promise<Response>(done => { arrived = done; });
    const wait = new Promise<Response>(done => { release = done; });
    gates.push({ route: route.split('?')[0], method, arrived, wait });
    return { response, release: async () => release(await response), fail: (message: string) => release(Response.json({ error: message }, { status: 503 })) };
  }
  async function reload(id = canvas.id): Promise<CanvasDocument> { return new CanvasStore(root).getCanvas(id); }
  return { root, store, workspace, secondWorkspace, baseUrl: apiBase, canvas: await reload(), secondCanvas, calls, hold, reload };
}

export async function closeWorkspaceFixtures() {
  for (const { root, servers, drain } of opened.splice(0)) {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await drain();
    }
    await rm(root, { recursive: true, force: true });
  }
}
