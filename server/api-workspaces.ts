import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { getJevRuntime } from './jev/runtime.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const workspaceAndSettingsEndpoints: Endpoint[] = [
  { method: 'GET', path: '/api/workspaces', handle: async context => {
    const workspaces = await context.store.listWorkspaces();
    if (context.url.searchParams.get('stats') !== '1') { sendJson(context.response, 200, workspaces); return; }
    sendJson(context.response, 200, await Promise.all(workspaces.map(async workspace => ({ ...workspace,
      canvases: await Promise.all(workspace.canvases.map(async canvas => {
        const [summary, file] = await Promise.all([context.store.getCanvasSummary(canvas.id),
          stat(path.join(context.store.root, 'canvases', `${canvas.id}.json`))]);
        return { ...canvas, documentCount: summary.blocks.length, lastUpdatedAt: file.mtime.toISOString(),
          lastUpdatedMeaning: 'canvas metadata file modification time' };
      })),
    }))));
  } },
  { method: 'POST', path: '/api/workspaces', handle: async context => {
    sendJson(context.response, 201, await context.store.createWorkspace(await readBody(context.request)));
  } },
  { method: 'GET', path: '/api/settings', handle: async context => {
    sendJson(context.response, 200, await context.store.getSettings());
  } },
  { method: 'PUT', path: '/api/settings', handle: async context => {
    const input = await readBody(context.request);
    sendJson(context.response, 200, await context.store.updateSettings(input));
    if (input.secrets && Object.hasOwn(input.secrets as object, 'TYPESAFE_API_KEY')) {
      await getJevRuntime(context.store, { fetcher: context.fetcher }).reconcile();
    }
  } },
];

export function workspaceAndSettings(context: RouteContext): Promise<boolean> { return runEndpoints(context, workspaceAndSettingsEndpoints); }

const workspaceCanvasEndpoints: Endpoint[] = [
  { method: 'DELETE', path: /^\/api\/workspaces\/([^/]+)$/, handle: async (context, match) => {
    await context.store.deleteWorkspace(match[1]);
    sendJson(context.response, 200, { ok: true });
  } },
  { method: 'POST', path: /^\/api\/workspaces\/([^/]+)\/canvases$/, handle: async (context, match) => {
    sendJson(context.response, 201, await context.store.createCanvas(match[1], await readBody(context.request)));
  } },
];

export function workspaceCanvas(context: RouteContext): Promise<boolean> { return runEndpoints(context, workspaceCanvasEndpoints); }
