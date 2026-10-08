import type { RouteContext } from './api-context.js';
import { readBody } from './api-http.js';
import { accessTokens, bearerToken, isInternal, safeEqual } from './auth.js';
import { ApiError } from './errors.js';
import { currentMcpIdentity, jevApiPrincipal } from './jev-api-principal.js';
import type { JevPrincipal } from '../shared/jev-types.js';
import { withinApiMutationAuthority } from './api-mutation-authority.js';
import { matchingApiContracts } from './mcp-api-contract.js';
import { canCallMcpTool, mcpCanvasIds } from './mcp-scope.js';

function agentRequest(context: RouteContext): boolean {
  const bearer = bearerToken(context.request);
  return context.route === '/api/mcp/caller' || context.route === '/api/mcp/calls' || isInternal(context.request)
    || context.request.headers['x-symbiknow-agent-transport'] === 'mcp'
    || Boolean(bearer && !accessTokens().some(token => safeEqual(token, bearer)));
}
function hasBody(context: RouteContext): boolean {
  const length = context.request.headers['content-length'];
  return Boolean(context.request.headers['content-type'] || context.request.headers['transfer-encoding'] || (length && length !== '0'));
}
const systemOperations = new Set(['GET /api/mcp/caller', 'POST /api/mcp/calls']);
function canonicalDeclaration(context: RouteContext): string | undefined {
  const declared = context.request.headers['x-symbiknow-mcp-tool'];
  if (declared !== undefined && typeof declared !== 'string') throw new ApiError(403, 'Invalid canonical MCP tool declaration');
  return declared;
}
async function operationBody(context: RouteContext) {
  if (!hasBody(context) || ['GET', 'HEAD'].includes(context.method)) return {};
  return readBody(context.request);
}
function commitsWithProposalAccess(tool: string, access: JevPrincipal['access'], body: Record<string, unknown>) {
  return tool === 'upload_file' && access === 'propose' && body.mode !== 'propose';
}
function canvasArgumentsAllowed(principal: JevPrincipal, args: unknown): boolean {
  return !principal.allowedCanvasIds || mcpCanvasIds(args).every(id => principal.allowedCanvasIds!.includes(id));
}
/** Agent API access is bounded by the actual canonical tool operation, not a claimed tool name. */
export async function authorizeMcpApi(context: RouteContext): Promise<boolean> {
  if (!agentRequest(context)) return false;
  const principal = await jevApiPrincipal(context.store, context.request, true);
  context.mcpPrincipal = principal;
  context.actor = principal.id;
  await requireCanonicalOperation(context, principal);
  return true;
}

async function requireCanonicalOperation(context: RouteContext, principal: JevPrincipal): Promise<void> {
  context.signal.throwIfAborted();
  if (systemOperations.has(`${context.method} ${context.route}`)) return;
  const declared = canonicalDeclaration(context);
  const candidates = matchingApiContracts(context.method, context.route, context.url.searchParams, declared)
    .filter(({ tool }) => canCallMcpTool(principal.access, tool.name, principal.tools, principal));
  if (!candidates.length) throw new ApiError(403, 'This caller does not permit that canonical API operation');
  const body = await operationBody(context);
  const query = Object.fromEntries(context.url.searchParams);
  const permitted = candidates.some(candidate => {
    if (candidate.bodySchema && !candidate.bodySchema.safeParse(body).success) return false;
    if (commitsWithProposalAccess(candidate.tool.name, principal.access, body)) return false;
    return canvasArgumentsAllowed(principal, { body, query, params: candidate.params });
  });
  if (!permitted) throw new ApiError(403, 'This caller does not permit those tool arguments or canvases');
  context.signal.throwIfAborted();
}

/** Revalidate queued mutations after they acquire storage serialization, before any state changes. */
export function withinMcpApiAuthority<T>(context: RouteContext, operation: () => Promise<T>): Promise<T> {
  const original = context.mcpPrincipal;
  if (!original) return operation();
  return withinApiMutationAuthority(async () => {
    const current = original.id === 'local-stdio-agent'
      ? await jevApiPrincipal(context.store, context.request, true)
      : await currentMcpIdentity(context.store, original.id);
    if (!current) throw new ApiError(401, 'The agent token is no longer authorized');
    context.mcpPrincipal = current;
    await requireCanonicalOperation(context, current);
  }, operation);
}
