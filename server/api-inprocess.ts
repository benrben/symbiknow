import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CanvasStore } from './storage.js';
import type { RouteContext } from './api-context.js';
import { ApiError } from './errors.js';
import { hasApiAccess, requestActor } from './auth.js';
import { sendJson } from './api-http.js';
import { documentSearch } from './api-search.js';
import { jevRoutes } from './api-jev.js';
import { symbiRoutes } from './api-symbi.js';
import { workspaceAndSettings, workspaceCanvas } from './api-workspaces.js';
import { canvasDocument, canvasLink, canvasImports, versionRoutes, canvasBlockMove, canvasLayout, canvasBlocks, blockDocument, blockDownload, websiteAsset } from './api-documents.js';
import { lockRoutes } from './api-locks.js';
import { todoRoutes } from './api-todos.js';
import { fileCheckoutRoutes } from './api-file-checkouts.js';
import { fileProposalRoutes } from './api-file-proposals.js';
import { requireReviewedAgentWrite } from './jev-agent-write-guard.js';
import { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';
import { mcpCallerRoute } from './api-mcp-caller.js';
import { authorizeMcpApi, withinMcpApiAuthority } from './mcp-api-authorization.js';

class ApiResponse extends Writable {
  statusCode = 200;
  readonly headers = new Headers();
  readonly chunks: Buffer[] = [];
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
    return this;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk)); callback();
  }
  response(): Response {
    const body = [204, 304].includes(this.statusCode) ? null : Buffer.concat(this.chunks);
    return new Response(body, { status: this.statusCode, headers: this.headers });
  }
}

const handlers = [mcpCallerRoute, documentSearch, jevRoutes, symbiRoutes, fileCheckoutRoutes, fileProposalRoutes, workspaceAndSettings, workspaceCanvas,
  canvasDocument, versionRoutes, canvasBlockMove, canvasLayout, lockRoutes, todoRoutes, canvasBlocks,
  canvasImports, canvasLink, blockDocument, blockDownload, websiteAsset];

async function dispatch(context: RouteContext): Promise<void> {
  if (!await authorizeMcpApi(context) && !hasApiAccess(context.request)) throw new ApiError(401, 'Workspace authentication is required');
  if (context.request.headers.origin === 'null' && !['GET', 'HEAD'].includes(context.method)) {
    throw new ApiError(403, 'Requests from sandboxed documents are not allowed');
  }
  await requireReviewedAgentWrite(context);
  await withinMcpApiAuthority(context, async () => {
    for (const handler of handlers) if (await handler(context)) return;
    sendJson(context.response, 404, { error: 'Route not found' });
  });
}

/** Fetch adapter over the actual API handlers; no second server or duplicate storage logic. */
export function createStoreApiFetcher(store: CanvasStore, options: Pick<RouteContext, 'fetcher' | 'symbiIndex' | 'symbiJudgments'> = {}): typeof fetch {
  return async (input, init) => {
    const source = new Request(input, init);
    source.signal.throwIfAborted();
    const text = await source.text();
    const request = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
      headers: Object.fromEntries(source.headers), method: source.method, url: source.url,
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    const response = new ApiResponse();
    const url = new URL(source.url);
    try {
      await dispatch({ store, ...options, symbiIndex: options.symbiIndex ?? SymbiIndexLifecycle.forStore(store),
        request, response: response as unknown as ServerResponse, method: source.method,
        route: url.pathname, url, actor: requestActor(request), signal: source.signal });
    } catch (error) {
      source.signal.throwIfAborted();
      if (!(error instanceof ApiError)) throw error;
      sendJson(response as unknown as ServerResponse, error.status, { error: error.message, ...error.details });
    }
    source.signal.throwIfAborted();
    return response.response();
  };
}
