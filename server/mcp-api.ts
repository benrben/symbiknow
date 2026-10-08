import type { CanvasBlock } from '../shared/types.js';
import { mcpCallSignal, mcpCallTool } from './mcp-call-context.js';

export function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
export function canvasPath(id: string, docId?: string): string {
  const base = `/canvases/${encodeURIComponent(id)}`;
  return docId ? `${base}/blocks/${encodeURIComponent(docId)}` : base;
}
function requestOptions(method: string, body: unknown, headers: Record<string, string>): RequestInit {
  return { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) };
}
export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly currentContentHash: string | undefined, message: string) { super(message); }
}
async function responseFailure(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string; currentContentHash?: string } | null;
  return new ApiRequestError(response.status, payload?.currentContentHash,
    payload?.error || `Canvas API request failed (${response.status})`);
}
export class CanvasApi {
  constructor(private readonly base: string, private readonly fetcher: typeof fetch,
    private readonly headers: Record<string, string> | (() => Record<string, string>)) {}

  private requestHeaders() {
    return typeof this.headers === 'function' ? this.headers() : this.headers;
  }

  async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    const signal = mcpCallSignal();
    signal?.throwIfAborted();
    try { response = await this.fetcher(this.base + route, { ...requestOptions(method, body, { ...this.requestHeaders(), ...(mcpCallTool() ? { 'x-symbiknow-mcp-tool': mcpCallTool()! } : {}) }), signal }); }
    catch { if (signal?.aborted) throw signal.reason; throw new Error(`Canvas API is unavailable at ${this.base}`); }
    if (!response.ok) throw await responseFailure(response);
    return response.json() as Promise<T>;
  }
  async block(id: string, docId: string): Promise<CanvasBlock> {
    return this.request<CanvasBlock>(canvasPath(id, docId));
  }
}
