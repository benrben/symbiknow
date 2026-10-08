import { type IncomingMessage, type ServerResponse } from 'node:http';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ApiError } from './storage.js';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function serveApp(route: string, response: ServerResponse): Promise<void> {
  const dist = path.resolve('dist');
  const file = appFile(dist, route);
  const body = await appBody(dist, file);
  const extension = path.extname(file) || '.html';
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  };
  const immutableAsset = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(route);
  response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    ...(immutableAsset ? { 'cache-control': 'public, max-age=31536000, immutable' }
      : extension === '.html' ? { 'cache-control': 'no-cache' } : {}),
  });
  response.end(body);
}

export function appFile(dist: string, route: string): string {
  const requested = path.resolve(dist, `.${decodeURIComponent(route)}`);
  if (requested !== dist && !requested.startsWith(`${dist}${path.sep}`)) throw new ApiError(400, 'Invalid app path');
  return route === '/' ? path.join(dist, 'index.html') : requested;
}

export async function appBody(dist: string, file: string): Promise<Buffer> {
  let body: Buffer;
  try { body = await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    if (path.extname(file)) throw new ApiError(404, 'App asset not found');
    body = await readFile(path.join(dist, 'index.html'));
  }
  return body;
}

const bodyCache = new WeakMap<IncomingMessage, Promise<Record<string, unknown>>>();
export function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = bodyCache.get(request);
  if (!body) { body = parseBody(request); bodyCache.set(request, body); }
  return body;
}
async function parseBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON means another site cannot post here with a plain form or a simple cross-origin request.
  if (!String(request.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'Send the request body as application/json');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 2_000_000) throw new ApiError(413, 'Request body is too large');
    chunks.push(part);
  }
  return jsonObject(Buffer.concat(chunks).toString('utf8'));
}

export function jsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'Expected a JSON object'); }
}
