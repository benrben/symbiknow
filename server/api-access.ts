import { accessToken, clearedSessionCookie, hasApiAccess, sessionCookie, validAccessToken } from './auth.js';
import { ApiError } from './errors.js';
import type { RouteContext } from './api-context.js';
import { sendJson, readBody } from './api-http.js';
import { runEndpoints, type Endpoint } from './api-router.js';

async function signIn(context: RouteContext): Promise<void> {
  const { token } = await readBody(context.request);
  if (!accessToken()) {
    sendJson(context.response, 200, { authRequired: false, authenticated: true });
    return;
  }
  if (!validAccessToken(token)) throw new ApiError(401, 'That access token is not correct');
  context.response.setHeader('set-cookie', sessionCookie(context.request));
  sendJson(context.response, 200, { authRequired: true, authenticated: true });
}

const sessionEndpoints: Endpoint[] = [
  { method: 'GET', path: '/api/session', handle: async context => {
    sendJson(context.response, 200, { authRequired: Boolean(accessToken()), authenticated: hasApiAccess(context.request) });
  } },
  { method: 'POST', path: '/api/session', handle: signIn },
  { method: 'DELETE', path: '/api/session', handle: async context => {
    context.response.setHeader('set-cookie', clearedSessionCookie());
    sendJson(context.response, 200, { authRequired: Boolean(accessToken()), authenticated: false });
  } },
];

export function sessionRoutes(context: RouteContext): Promise<boolean> { return runEndpoints(context, sessionEndpoints); }
