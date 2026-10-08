import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AnswerSource, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import type { ChatProposal } from './chat-proposals.js';
import type { CanvasStore } from './storage.js';
import { recordMcpToolEvent } from './mcp-http-activity.js';
import { ApiError } from './errors.js';
import { createProjectMcpServer } from './mcp.js';
import { discoverMcpTools, mcpResultValue } from './mcp-client-tools.js';
import { materializeDownload, workingUpload, workingManifest } from './agent-workspace.js';
import type { ChatStreamOptions } from './chat-stream-types.js';
import { recordMcpRead } from './chat-mcp-citations.js';

export type SymbiToolContext = { store: CanvasStore; canvasId: string; query: string; workdir: string; currentView?: ChatViewContext; signal?: AbortSignal;
  navigationRequests: CanvasNavigationTarget[]; researchPatches: ResearchCanvasPatch[]; proposals?: ChatProposal[];
  readSources?: AnswerSource[]; canvasNames?: Map<string, Promise<string>> };

function localSchema(item: Tool): Record<string, unknown> {
  const schema = { ...item.inputSchema, properties: { ...item.inputSchema.properties },
    required: (item.inputSchema.required ?? []).filter(name => name !== 'canvasId' && !(item.name === 'draw_research_canvas' && name === 'query')) };
  if (item.name === 'download_file') Object.assign(schema.properties, { destinationPath: { type: 'string' }, overwrite: { type: 'boolean' } });
  if (item.name === 'upload_file') {
    delete schema.properties.content;
    Object.assign(schema.properties, { sourcePath: { type: 'string', description: 'Path of the edited local working file.' } });
    schema.required = [...schema.required.filter(name => !['canvasId', 'checkoutId', 'idempotencyKey', 'filename', 'mode', 'content'].includes(name)), 'sourcePath'];
  }
  return schema;
}

function presentation(value: unknown, context: SymbiToolContext): void {
  if (!value || typeof value !== 'object') return;
  const payload = (value as { presentation?: { navigation?: CanvasNavigationTarget; researchPatch?: ResearchCanvasPatch } }).presentation;
  if (payload?.navigation) context.navigationRequests.push(payload.navigation);
  if (payload?.researchPatch) context.researchPatches.push(payload.researchPatch);
}

function proposalIdentity(value: unknown, canvasId?: unknown) {
  const receipt = value as { proposalId?: string; id?: string; canvasId?: string } | null;
  const id = receipt?.proposalId ?? receipt?.id;
  const canvas = receipt?.canvasId ?? canvasId;
  return { id, canvas };
}

async function readProposal(client: Client, canvasId: string, proposalId: string, signal?: AbortSignal): Promise<ChatProposal> {
  const output = await client.callTool({ name: 'read_file_proposal', arguments: { canvasId, proposalId } }, undefined, { signal });
  const proposal = mcpResultValue(output as { content?: unknown; structuredContent?: unknown }) as ChatProposal;
  if (output.isError) throw new Error(`The upload proposal was saved but could not be loaded for review: ${JSON.stringify(proposal)}`);
  return proposal;
}

async function publishProposal(client: Client, value: unknown, context: SymbiToolContext, canvasId?: unknown, signal?: AbortSignal): Promise<void> {
  const { id, canvas } = proposalIdentity(value, canvasId);
  if (!id || typeof canvas !== 'string') return;
  const proposal = await readProposal(client, canvas, id, signal);
  const pending = context.proposals ??= [];
  if (proposal.status !== 'pending') {
    context.proposals = pending.filter(item => item.id !== id);
    return;
  }
  if (!pending.some(item => item.id === proposal.id)) pending.push(proposal);
}

async function uploadInput(args: Record<string, unknown>, context: SymbiToolContext): Promise<Record<string, unknown>> {
  const input = await workingUpload(context.workdir, args, context.canvasId);
  const view = context.currentView;
  if (!view?.editorHasUnsavedChanges || !view.editingBlockId) return input;
  const manifest = input.checkoutId ? await workingManifest(context.workdir, String(args.sourcePath)) : null;
  if (input.canvasId === context.canvasId && manifest?.documentId === view.editingBlockId)
    throw new ApiError(409, 'Save or discard your unsaved editor changes before Symbi uploads this document.');
  return input;
}

async function toolInput(item: Tool, args: Record<string, unknown>, context: SymbiToolContext): Promise<Record<string, unknown>> {
  let input = { ...args };
  defaultPresentationQuery(item, input, context.query);
  if (item.name === 'upload_file') input = await uploadInput(input, context);
  if (item.inputSchema.required?.includes('canvasId') && input.canvasId === undefined) input.canvasId = context.canvasId;
  return input;
}

function defaultPresentationQuery(item: Tool, input: Record<string, unknown>, query: string): void {
  if (item.inputSchema.properties?.query && item.name === 'draw_research_canvas' && input.query === undefined) input.query = query;
}

async function downloadResult(value: Record<string, unknown>, input: Record<string, unknown>, context: SymbiToolContext): Promise<string> {
  const local: Record<string, unknown> = { ...await materializeDownload(context.workdir, value,
    typeof input.destinationPath === 'string' ? input.destinationPath : undefined, input.overwrite === true) };
  delete local.content;
  return JSON.stringify(local);
}

async function invoke(client: Client, item: Tool, args: Record<string, unknown>, context: SymbiToolContext, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const input = await toolInput(item, args, context);
  const { destinationPath, overwrite, ...remote } = input;
  const output = await client.callTool({ name: item.name, arguments: remote }, undefined, { signal });
  const value = mcpResultValue(output as { content?: unknown; structuredContent?: unknown });
  if (output.isError) throw new Error(serializedResult(value));
  await recordMcpRead(client, item.name, remote, value, context, signal);
  presentation(value, context);
  if (item._meta?.publishProposal) await publishProposal(client, value, context, remote.canvasId, signal);
  return localResult(item, value, { destinationPath, overwrite }, context);
}

function serializedResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function localResult(item: Tool, value: unknown, input: Record<string, unknown>, context: SymbiToolContext): Promise<string> {
  if (item.name === 'download_file' && value && typeof value === 'object') return downloadResult(value as Record<string, unknown>, input, context);
  return serializedResult(value);
}

export async function symbiMcpTools(context: SymbiToolContext, options: ChatStreamOptions): Promise<{ tools: StructuredToolInterface[]; close: () => Promise<void> }> {
  const server = createProjectMcpServer(options.mcpApiBase, options.mcpFetcher, { localFiles: false,
    headers: options.mcpHeaders, actorSuffix: 'Symbi', access: 'write', canApprove: true, canConfigure: true, callerId: 'symbi',
    onToolCall: event => recordMcpToolEvent(context.store, { id: 'symbi', name: 'Symbi', access: 'write' }, event) });
  const client = new Client({ name: 'symbi', version: '0.2.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => { await Promise.all([client.close(), server.close()]); };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const items = await discoverMcpTools(client, context.signal);
    let presentationTail: Promise<unknown> = Promise.resolve();
    return { tools: items.map(item => new DynamicStructuredTool({ name: item.name,
      description: item.description ?? item.name, schema: localSchema(item),
      func: async (args: Record<string, unknown>, _manager, config) => {
        const signals = [context.signal, config?.signal].filter((value): value is AbortSignal => Boolean(value));
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        if (item._meta?.presentation) {
          const result = presentationTail.then(() => invoke(client, item, args, context, signal));
          presentationTail = result.then(() => undefined, () => undefined);
          return result;
        }
        return invoke(client, item, args, context, signal);
      } }) as StructuredToolInterface), close };
  } catch (error) { await close(); throw error; }
}
