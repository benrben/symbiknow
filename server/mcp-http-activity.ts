import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { canCallMcpTool } from './mcp.js';
import { projectMcpMetadata } from './mcp-registry.js';
import { mcpActivityRefs, mcpResultIds, safeMcpError, type McpActivityInput } from './mcp-activity.js';
import { toolCalls } from './mcp-http-protocol.js';
import type { McpHttpIdentity, McpHttpToolCall, McpHttpToolEvent } from './mcp-http-types.js';
import type { CanvasStore } from './storage.js';

type CallContext = { completed: Map<string, number> };
type Outcome = McpActivityInput['outcome'];
type Refs = ReturnType<typeof mcpActivityRefs>;
const callContext = new AsyncLocalStorage<CallContext>();
function references(name: string, args: unknown, result: unknown) {
  const refs = mcpActivityRefs(args);
  const returned = mcpResultIds(result);
  if (projectMcpMetadata().find(tool => tool.name === name)?.documentResult && returned.documentId && !refs.documentIds.includes(returned.documentId)) refs.documentIds.push(returned.documentId);
  return { refs, returned };
}

function needsDocumentRevision(outcome: Outcome, refs: Refs, revision?: string): boolean {
  if (revision || outcome !== 'success') return false;
  return refs.canvasIds.length === 1 && refs.documentIds.length === 1;
}

async function documentRevision(store: CanvasStore, outcome: Outcome, refs: Refs, revision?: string) {
  return needsDocumentRevision(outcome, refs, revision) ? store.mcpDocumentRevision(refs.documentIds[0]) : revision;
}

function revisionFields(revision: string | undefined): Pick<McpActivityInput, 'revision'> {
  return revision && /^[0-9a-f]{40}$/i.test(revision) ? { revision } : {};
}

function scopeFields(identity: McpHttpIdentity): Pick<McpActivityInput, 'allowedCanvasIds' | 'tools'> {
  return { ...(identity.allowedCanvasIds ? { allowedCanvasIds: identity.allowedCanvasIds } : {}),
    ...(identity.tools ? { tools: identity.tools } : {}) };
}

function errorFields(outcome: Outcome, reason: unknown): Pick<McpActivityInput, 'error'> {
  return outcome === 'success' ? {} : { error: safeMcpError(outcome, reason) };
}

export async function recordCall(store: CanvasStore, identity: McpHttpIdentity, call: McpHttpToolCall, startedAt: string,
  endedAt: string, outcome: Outcome, result?: unknown, reason?: unknown): Promise<void> {
  const { refs, returned } = references(call.name, call.args, result);
  const revision = await documentRevision(store, outcome, refs, returned.revision);
  await store.recordMcpActivity({ tokenId: identity.id, tokenName: identity.name, access: identity.access,
    ...scopeFields(identity), tool: call.name, startedAt, endedAt, outcome, ...errorFields(outcome, reason),
    ...refs, ...revisionFields(revision) });
}

export async function recordMcpToolEvent(store: CanvasStore, identity: McpHttpIdentity, event: McpHttpToolEvent): Promise<void> {
  const context = callContext.getStore();
  context?.completed.set(event.tool, (context.completed.get(event.tool) ?? 0) + 1);
  await recordCall(store, identity, { name: event.tool, args: event.args }, event.startedAt, event.endedAt, event.outcome, event.result);
}

export async function dispatchMcpRequest(store: CanvasStore, identity: McpHttpIdentity, transport: StreamableHTTPServerTransport,
  request: IncomingMessage, response: ServerResponse, parsed: unknown): Promise<void> {
  const startedAt = new Date().toISOString();
  const calls = toolCalls(parsed);
  const context: CallContext = { completed: new Map() };
  try { await callContext.run(context, () => transport.handleRequest(request, response, parsed)); }
  finally {
    for (const call of calls) {
      const completed = context.completed.get(call.name) ?? 0;
      if (completed) { context.completed.set(call.name, completed - 1); continue; }
      const denied = !canCallMcpTool(identity.access, call.name, identity.tools, identity);
      await recordCall(store, identity, call, startedAt, new Date().toISOString(), denied ? 'denied' : 'error');
    }
  }
}
