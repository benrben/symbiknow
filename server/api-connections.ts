import { accessToken, publicOrigin } from './auth.js';
import { mcpSessionCount } from './mcp-http.js';
import { listModels } from './providers.js';
import { testExternal } from './external-mcp.js';
import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';
import { candidateServer } from './api-connection-server.js';

async function testServer(context: RouteContext): Promise<void> {
  const body = await readBody(context.request);
  const settings = await context.store.secretSettings();
  const candidate = candidateServer(body, settings);
  sendJson(context.response, 200, await testExternal(candidate, settings.secrets ?? {}));
}

const connectionEndpoints: Endpoint[] = [
  { method: 'GET', path: '/api/mcp/activity', handle: async context => {
    sendJson(context.response, 200, await context.store.mcpActivity());
  } },
  { method: 'GET', path: '/api/mcp/info', handle: async context => {
    const origin = publicOrigin(context.request);
    sendJson(context.response, 200, { origin, endpoint: `${origin}/mcp`, publicUrlConfigured: Boolean(process.env.PUBLIC_URL),
      accessProtected: Boolean(accessToken()), activeSessions: mcpSessionCount() });
  } },
  { method: 'POST', path: '/api/mcp/tokens', handle: async context => {
    const { name, access, allowedCanvasIds, tools } = await readBody(context.request);
    sendJson(context.response, 201, await context.store.createMcpToken(name, access, { allowedCanvasIds, tools }));
  } },
  { method: 'DELETE', path: /^\/api\/mcp\/tokens\/([^/]+)$/, handle: async (context, match) => {
    sendJson(context.response, 200, await context.store.revokeMcpToken(decodeURIComponent(match[1])));
  } },
  { method: 'POST', path: '/api/mcp/servers/test', handle: testServer },
  { method: 'GET', path: '/api/models', handle: async context => {
    sendJson(context.response, 200, await listModels(await context.store.secretSettings(), context.url.searchParams.get('provider'), context.fetcher));
  } },
];

export function connectionRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, connectionEndpoints); }
