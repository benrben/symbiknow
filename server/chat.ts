import type { ChatMessage, ChatReply } from '../shared/types.js';
import { ApiError, CanvasStore } from './storage.js';

type ModelToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ModelToolCall[]; tool_call_id?: string };

const tools = [
  { type: 'function', function: { name: 'search_docs', description: 'Search Markdown documents in the workspace by text.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_doc', description: 'Read a block and its Markdown content from the active canvas.', parameters: { type: 'object', properties: { blockId: { type: 'string' } }, required: ['blockId'] } } },
  { type: 'function', function: { name: 'create_doc', description: 'Create a Markdown block on the active canvas.', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['title', 'content'] } } },
  { type: 'function', function: { name: 'edit_doc', description: 'Replace the Markdown content or title of a block on the active canvas.', parameters: { type: 'object', properties: { blockId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['blockId'] } } },
  { type: 'function', function: { name: 'move_block', description: 'Move a block to canvas coordinates.', parameters: { type: 'object', properties: { blockId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['blockId', 'x', 'y'] } } },
  { type: 'function', function: { name: 'link_blocks', description: 'Link one block to another on the active canvas.', parameters: { type: 'object', properties: { fromBlockId: { type: 'string' }, toBlockId: { type: 'string' } }, required: ['fromBlockId', 'toBlockId'] } } },
] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ApiError(400, `${name} must be a string`);
  return value;
}

function checkedMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new ApiError(400, 'messages must contain 1 to 30 messages');
  }
  return value.map(item => {
    const message = object(item);
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || message.content.length > 20_000) {
      throw new ApiError(400, 'Invalid chat message');
    }
    return { role: message.role, content: message.content };
  });
}

type ToolOutcome = { result: unknown; changed: boolean };
type ToolExecutor = (store: CanvasStore, canvasId: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

const readDoc: ToolExecutor = async (store, canvasId, args) => {
  const canvas = await store.getCanvas(canvasId);
  const block = canvas.blocks.find(item => item.id === string(args.blockId, 'blockId'));
  if (!block) throw new ApiError(404, 'Block not found');
  return { result: block, changed: false };
};

const linkBlocks: ToolExecutor = async (store, canvasId, args) => {
  const fromId = string(args.fromBlockId, 'fromBlockId');
  const toId = string(args.toBlockId, 'toBlockId');
  const canvas = await store.getCanvas(canvasId);
  const from = canvas.blocks.find(block => block.id === fromId);
  if (!from) throw new ApiError(404, 'Source block not found');
  return { result: await store.updateBlock(canvasId, fromId, { links: [...new Set([...from.links, toId])] }), changed: true };
};

const executors: Record<string, ToolExecutor> = {
  search_docs: async (store, _canvasId, args) => ({ result: await store.search(string(args.query, 'query')), changed: false }),
  read_doc: readDoc,
  create_doc: async (store, canvasId, args) => ({ result: await store.createBlock(canvasId, args), changed: true }),
  edit_doc: async (store, canvasId, args) => ({ result: await store.updateBlock(canvasId, string(args.blockId, 'blockId'), args), changed: true }),
  move_block: async (store, canvasId, args) => ({ result: await store.updateBlock(canvasId, string(args.blockId, 'blockId'), args), changed: true }),
  link_blocks: linkBlocks,
};

async function executeTool(store: CanvasStore, canvasId: string, call: ModelToolCall): Promise<ToolOutcome> {
  const args = object(JSON.parse(call.function.arguments || '{}'));
  const execute = executors[call.function.name];
  if (!execute) throw new ApiError(400, `Unknown tool: ${call.function.name}`);
  return execute(store, canvasId, args);
}

type ChatContext = { canvasId: string; apiKey: string; model: string; messages: ModelMessage[] };

async function prepareContext(store: CanvasStore, body: Record<string, unknown>): Promise<ChatContext> {
  const canvasId = string(body.canvasId, 'canvasId');
  await store.getCanvas(canvasId);
  const history = checkedMessages(body.messages);
  const settings = await store.getSettings();
  const apiKey = await store.getApiKey();
  if (!apiKey) throw new ApiError(400, 'Set an OpenRouter API key in Settings before using chat');
  if (!settings.model) throw new ApiError(400, 'Set an OpenRouter model in Settings before using chat');
  return {
    canvasId, apiKey, model: settings.model,
    messages: [
      { role: 'system', content: `${settings.systemPrompt}\n\nThe active canvas ID is ${canvasId}. Use the provided tools to inspect or change its Markdown files. Report changes accurately.` },
      ...history,
    ],
  };
}

async function upstreamErrorDetail(response: Response, apiKey: string): Promise<string> {
  try {
    const error = object(await response.json());
    const nested = error.error && typeof error.error === 'object' ? object(error.error) : error;
    return typeof nested.message === 'string' ? nested.message.replaceAll(apiKey, '[redacted]').slice(0, 300) : '';
  } catch {
    // OpenRouter error responses may have no JSON body.
    return '';
  }
}

async function checkResponse(response: Response, apiKey: string): Promise<void> {
  if (response.ok) return;
  const detail = await upstreamErrorDetail(response, apiKey);
  throw new ApiError(502, `OpenRouter request failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function modelMessage(response: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown>;
  try { payload = object(await response.json()); }
  catch { throw new ApiError(502, 'OpenRouter returned an invalid response'); }
  return messageFromPayload(payload);
}

function messageFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = payload.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  if (!message || typeof message !== 'object') throw new ApiError(502, 'OpenRouter returned no message');
  return message as Record<string, unknown>;
}

async function requestCompletion(context: ChatContext, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${context.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'SymbiKnow' },
      body: JSON.stringify({ model: context.model, messages: context.messages, tools, tool_choice: 'auto', parallel_tool_calls: false }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ApiError(502, 'Could not reach OpenRouter');
  }
  await checkResponse(response, context.apiKey);
  return modelMessage(response);
}

function toolCalls(message: Record<string, unknown>): ModelToolCall[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls as ModelToolCall[] : [];
}

function textReply(message: Record<string, unknown>, changed: boolean): ChatReply {
  if (typeof message.content !== 'string') throw new ApiError(502, 'OpenRouter returned no text');
  return { message: message.content, changed };
}

function validToolCall(value: unknown): value is ModelToolCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Record<string, unknown>;
  if (!call.function || typeof call.function !== 'object') return false;
  const fn = call.function as Record<string, unknown>;
  return [typeof call.id, call.type, typeof fn.name, typeof fn.arguments].join('|') === 'string|function|string|string';
}

async function appendToolResult(store: CanvasStore, context: ChatContext, call: ModelToolCall): Promise<boolean> {
  let result: unknown;
  let changed = false;
  try {
    const outcome = await executeTool(store, context.canvasId, call);
    result = outcome.result;
    changed = outcome.changed;
  } catch (error) {
    result = { error: error instanceof Error ? error.message : 'Tool failed' };
  }
  context.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  return changed;
}

async function runToolCalls(store: CanvasStore, context: ChatContext, message: Record<string, unknown>, calls: ModelToolCall[]): Promise<boolean> {
  context.messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: calls });
  let changed = false;
  for (const call of calls) {
    if (!validToolCall(call)) throw new ApiError(502, 'OpenRouter returned an invalid tool call');
    const callChanged = await appendToolResult(store, context, call);
    changed ||= callChanged;
  }
  return changed;
}

export async function chat(store: CanvasStore, body: Record<string, unknown>, fetcher: typeof fetch = fetch, maxToolCalls = 9999): Promise<ChatReply> {
  const context = await prepareContext(store, body);
  let changed = false;
  let toolCallsUsed = 0;
  while (true) {
    const message = await requestCompletion(context, fetcher);
    const calls = toolCalls(message);
    if (calls.length === 0) return textReply(message, changed);
    if (toolCallsUsed + calls.length > maxToolCalls) throw new ApiError(502, 'OpenRouter exceeded the tool call limit');
    const turnChanged = await runToolCalls(store, context, message, calls);
    changed ||= turnChanged;
    toolCallsUsed += calls.length;
  }
}
