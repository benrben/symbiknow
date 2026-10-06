import { afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { CanvasStore } from './storage.js';
import { chatAgent, type ChatStreamEvent } from './chat-agent.js';
import type { AgentStreamItem } from './chat-agent-types.js';
import { createChatSession, type SessionContext } from './chat-session.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { canvasTools } from './chat-tools.js';
import { createApiServer } from './index.js';

export type ModelRequest = { model: string; stream: boolean; messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }> };
type BoundaryRequest<T> = { body: T; authorization: string | undefined; url: string | undefined };
type Handler<T> = (body: T, response: ServerResponse, request: IncomingMessage) => void;
type Boundary<T> = { requests: BoundaryRequest<T>[]; handle: Handler<T>; base: string;
  observers: Array<(request: T) => void>; closed: number };
const servers: Server[] = [];
const roots: string[] = [];
let completion = 0;
const responseIds = new WeakMap<ServerResponse, string>();

export function begin(response: ServerResponse): void {
  responseIds.set(response, `session-${++completion}`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
}

export function chunk(response: ServerResponse, delta: unknown, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: responseIds.get(response), object: 'chat.completion.chunk', created: 1,
    model: 'native-session', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

export function answer(response: ServerResponse, pieces = ['The release ', 'requires QA approval.']): void {
  begin(response);
  chunk(response, { role: 'assistant', content: pieces[0] });
  for (const content of pieces.slice(1)) chunk(response, { content });
  chunk(response, {}, 'stop');
  response.end('data: [DONE]\n\n');
}

export function toolCalls(response: ServerResponse, calls: Array<{ name: string; args: unknown }>, note = ''): void {
  begin(response);
  if (note) chunk(response, { role: 'assistant', content: note });
  chunk(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
  response.end('data: [DONE]\n\n');
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing session fixture port');
  return `http://127.0.0.1:${address.port}`;
}

async function boundary<T>(handle: Handler<T>): Promise<Boundary<T>> {
  const fixture: Boundary<T> = { requests: [], handle, base: '', observers: [], closed: 0 };
  const server = createServer(async (request, response) => {
    const pieces: Buffer[] = [];
    for await (const piece of request) pieces.push(Buffer.from(piece));
    const body = JSON.parse(Buffer.concat(pieces).toString()) as T;
    fixture.requests.push({ body, authorization: request.headers.authorization, url: request.url });
    response.on('close', () => { fixture.closed++; });
    fixture.observers.splice(0).forEach(observer => observer(body));
    fixture.handle(body, response, request);
  });
  fixture.base = await listen(server);
  return fixture;
}

export function nextRequest<T>(fixture: Boundary<T>): Promise<T> {
  return new Promise(resolve => { fixture.observers.push(resolve); });
}

export function omittedModelPiece(item: AgentStreamItem, mode: 'missing-piece' | 'snapshots-only'): boolean {
  if (!Array.isArray(item) || item[0] !== 'messages') return false;
  if (mode === 'snapshots-only') return true;
  return Array.isArray(item[1]) && item[1][0].content === 'requires QA approval.';
}

export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-chat-session-'));
  roots.push(root);
  const model = await boundary<ModelRequest>((_body, response) => answer(response));
  const settings = { model: 'native-session', apiKey: 'local-model-secret', baseURL: `${model.base}/v1`, headers: {} };
  const store = new CanvasStore(root);
  await store.init();
  await store.updateSettings({ provider: 'custom', baseUrl: settings.baseURL, model: settings.model,
    apiKey: settings.apiKey });
  await store.updateBlock('product-roadmap', 'launch-checklist', {
    content: '# Launch checklist\n\nThe release requires QA approval.\nThe launch checklist records the release review owner.\n',
  });
  const canvas = await store.getCanvas('product-roadmap');

  async function sessionContext(overrides: Partial<SessionContext> = {}) {
    const draft = new ChatProposalDraft(store, canvas.id, canvas);
    const file = await open(path.join(root, `session-cleanup-${completion++}`), 'w');
    const cleanup = { closed: 0, file };
    const context: SessionContext = { model: settings.model, providerName: 'Local provider', messages: [new HumanMessage('Review the release.')],
      runAgent: chatAgent(settings, [], 'Answer using actual sources'), proposalDraft: draft,
      toolContext: { query: 'Review the release.', draft, navigationRequests: [], selectedSources: [], researchPatches: [] }, store, canvasId: canvas.id,
      context: { latest: 'Review the release.', previousAssistant: '', previousUser: '' }, answerCanvas: null,
      canvasEnabled: false, warnings: [], navigationRequests: [], researchPatches: [],
      close: async () => { cleanup.closed++; await file.close(); }, ...overrides };
    context.toolContext = { query: context.context.latest, draft: context.proposalDraft,
      navigationRequests: context.navigationRequests, selectedSources: context.answerCanvas?.sources ?? [],
      researchPatches: context.researchPatches, signal: context.preparationSignal };
    return { context, cleanup, session: createChatSession(context) };
  }

  async function toolSession(overrides: Partial<SessionContext> = {}) {
    const prepared = await sessionContext(overrides);
    const context = prepared.context;
    const tools = canvasTools(store, canvas.id, context.toolContext);
    context.runAgent = chatAgent(settings, tools, 'Use the requested canvas tools then answer.');
    return prepared;
  }

  async function app(): Promise<string> {
    return listen(await createApiServer({ dataDir: root }));
  }
  return { root, store, canvas, model, settings, sessionContext, toolSession, app };
}

export async function events(session: ReturnType<typeof createChatSession>, signal = new AbortController().signal): Promise<ChatStreamEvent[]> {
  if (!session.events) throw new Error('Missing session event stream');
  const result: ChatStreamEvent[] = [];
  for await (const event of session.events(signal)) result.push(event);
  return result;
}

export async function tokens(session: ReturnType<typeof createChatSession>, signal = new AbortController().signal): Promise<string[]> {
  const result: string[] = [];
  for await (const token of session.tokens(signal)) result.push(token);
  return result;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
