import type { AnswerCanvasResult, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch, ResearchSurfaceChoice } from '../shared/answer-canvas';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AgentStep = {
  type: 'thinking' | 'tool_start' | 'tool_end';
  id?: string;
  name?: string;
  message: string;
};

export type Verification = { status: 'checking' | 'supported' | 'unsupported' | 'unavailable' | 'no_claims'; score?: number };

type StreamOptions = {
  canvasId: string;
  messages: ChatTurn[];
  /** Ask the server for a draft with write tools disabled. */
  previewMerge?: boolean;
  intentToken?: string;
  viewContext?: ChatViewContext;
  signal: AbortSignal;
  onChunk: (content: string) => void;
  onStep?: (step: AgentStep) => void;
  /** The text streamed so far was a note before a tool call, not the answer. */
  onReset?: () => void;
  onVerification?: (verification: Verification) => void;
  onAnswerCanvas?: (canvas: AnswerCanvasResult) => void;
  onNavigation?: (target: CanvasNavigationTarget) => void;
  onResearchPatch?: (patch: ResearchCanvasPatch) => void;
  onPresentationChoice?: (choice: ResearchSurfaceChoice) => void;
  fetcher?: typeof fetch;
};

type Handlers = Pick<StreamOptions, 'onChunk' | 'onStep' | 'onReset' | 'onVerification' | 'onAnswerCanvas' | 'onNavigation' | 'onResearchPatch' | 'onPresentationChoice'>;

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Canvas chat request failed (${response.status}). Retry in a moment.`;
}

function frameData(frame: string): string {
  return frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
}

function frameEvent(frame: string): string {
  return frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
}

function isAgentStep(value: unknown): value is AgentStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Partial<AgentStep>;
  return (step.type === 'thinking' || step.type === 'tool_start' || step.type === 'tool_end') && typeof step.message === 'string';
}

function consumeAgentFrame(payload: unknown, onStep?: (step: AgentStep) => void): void {
  if (isAgentStep(payload)) onStep?.({ type: payload.type, id: payload.id, name: payload.name, message: payload.message });
}

function consumeCompletionFrame(payload: unknown, onChunk: (content: string) => void): void {
  const chunk = payload as { error?: string; choices?: Array<{ delta?: { content?: string } }> };
  if (chunk.error) throw new Error(chunk.error);
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === 'string') onChunk(content);
}

function isVerification(value: unknown): value is Verification {
  const status = (value as Partial<Verification> | null)?.status;
  return status === 'checking' || status === 'supported' || status === 'unsupported' || status === 'unavailable' || status === 'no_claims';
}

function isAnswerCanvas(value: unknown): value is AnswerCanvasResult {
  if (!value || typeof value !== 'object') return false;
  const canvas = value as Partial<AnswerCanvasResult>;
  return typeof canvas.query === 'string' && typeof canvas.canvasId === 'string'
    && (canvas.selection === 'jev' || canvas.selection === 'local') && Array.isArray(canvas.sources)
    && canvas.sources.every(source => typeof source.canvasId === 'string' && typeof source.blockId === 'string'
      && typeof source.title === 'string' && typeof source.excerpt === 'string');
}

function isNavigation(value: unknown): value is CanvasNavigationTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<CanvasNavigationTarget>;
  return typeof target.canvasId === 'string' && ((target.kind === 'document' && typeof target.blockId === 'string' && typeof target.title === 'string')
    || (target.kind === 'group' && typeof target.group === 'string' && typeof target.title === 'string'));
}

function isResearchPatch(value: unknown): value is ResearchCanvasPatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as Partial<ResearchCanvasPatch>;
  return typeof patch.query === 'string' && Array.isArray(patch.blocks) && Array.isArray(patch.edges)
    && patch.blocks.every(block => typeof block.id === 'string' && typeof block.title === 'string' && typeof block.content === 'string'
      && (block.kind === undefined || ['markdown', 'html', 'slides', 'website', 'mdx'].includes(block.kind))
      && ['text', 'diagram', 'task', 'section'].includes(block.type) && Array.isArray(block.sourceIds))
    && patch.edges.every(edge => typeof edge.from === 'string' && typeof edge.to === 'string');
}

function isPresentationChoice(value: unknown): value is ResearchSurfaceChoice {
  if (!value || typeof value !== 'object') return false;
  const choice = value as Partial<ResearchSurfaceChoice>;
  return typeof choice.question === 'string' && Array.isArray(choice.options) && choice.options.length > 0
    && choice.options.every(option => typeof option.label === 'string' && typeof option.detail === 'string' && typeof option.prompt === 'string');
}

function consumeFrame(frame: string, handlers: Handlers): boolean {
  const data = frameData(frame);
  if (data === '[DONE]') return true;
  if (!data) return false;
  const payload = JSON.parse(data) as unknown;
  const event = frameEvent(frame);
  if (event === 'agent_step') consumeAgentFrame(payload, handlers.onStep);
  else if (event === 'answer_reset') handlers.onReset?.();
  else if (event === 'verification') { if (isVerification(payload)) handlers.onVerification?.(payload); }
  else if (event === 'answer_canvas') { if (isAnswerCanvas(payload)) handlers.onAnswerCanvas?.(payload); }
  else if (event === 'canvas_navigation') { if (isNavigation(payload)) handlers.onNavigation?.(payload); }
  else if (event === 'research_canvas_patch') { if (isResearchPatch(payload)) handlers.onResearchPatch?.(payload); }
  else if (event === 'presentation_choice') { if (isPresentationChoice(payload)) handlers.onPresentationChoice?.(payload); }
  else if (event === 'error') throw new Error((payload as { message?: string }).message || 'The assistant stopped. Please retry.');
  else consumeCompletionFrame(payload, handlers.onChunk);
  return false;
}

async function consumeStream(body: ReadableStream<Uint8Array>, handlers: Handlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        if (consumeFrame(pending.slice(0, boundary), handlers)) return;
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');
      }
      if (done) throw new Error('The assistant connection closed before the reply completed. Please retry.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function streamCanvasChat({ canvasId, messages, previewMerge = false, intentToken, viewContext, signal, fetcher = fetch, ...handlers }: StreamOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetcher('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-symbiknow-actor': 'Browser' },
      body: JSON.stringify({ canvasId, messages, viewContext, ...(previewMerge ? { previewMerge: true } : {}), ...(intentToken ? { intentToken } : {}) }),
      signal,
    });
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new Error('Canvas server is unavailable. Check that it is running, then retry.');
  }
  if (signal.aborted) throw signal.reason;
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error('The assistant returned an empty stream. Please retry.');
  await consumeStream(response.body, handlers);
}
