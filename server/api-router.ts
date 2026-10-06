import type { RouteContext } from './api-context.js';

export type Endpoint = { method: string; path: string | RegExp;
  handle: (context: RouteContext, match: RegExpMatchArray) => Promise<void> };

function matchPath(route: string, path: string | RegExp): RegExpMatchArray | null {
  if (typeof path !== 'string') return route.match(path);
  return route === path ? [route] : null;
}

export async function runEndpoints(context: RouteContext, endpoints: Endpoint[]): Promise<boolean> {
  for (const endpoint of endpoints) {
    if (context.method !== endpoint.method) continue;
    const match = matchPath(context.route, endpoint.path);
    if (!match) continue;
    await endpoint.handle(context, match);
    return true;
  }
  return false;
}
