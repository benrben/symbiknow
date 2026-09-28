import type { AnswerCanvasResult, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch, ResearchSurfaceChoice } from '../shared/answer-canvas';
import type { CanvasBlock } from '../shared/types';
import type { EvidenceReference } from '../shared/evidence';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type AgentStep = {
  type: 'thinking' | 'tool_start' | 'tool_end';
  id?: string;
  name?: string;
  message: string;
};

export type VerificationSource = { canvasId: string; blockId: string; title: string; contentHash?: string; excerpt?: string;
  evidence?: EvidenceReference };
export type Verification = { status: 'checking' | 'supported' | 'unsupported' | 'unavailable' | 'no_claims'; score?: number;
  checkedClaims?: number; totalClaims?: number;
  claims?: Array<{ text: string; score: number; supported: boolean; source?: VerificationSource }>;
  sources?: VerificationSource[] };

export type ChatProposalChange = { id: string; type: 'create' | 'edit' | 'delete' | 'move' | 'link'; blockId: string; title: string;
  before: CanvasBlock | null; after: CanvasBlock | null; expectedContentHash: string | null; expectedStateHash?: string | null; canApply?: boolean };
export type ChatProposal = { id: string; canvasId: string; changes: ChatProposalChange[]; status: 'pending'; expiresAt?: string };
export type ChatProposalReceipt = { id: string; status: 'applied' | 'partial'; applied: string[];
  skipped: Array<{ id: string; reason: string }>; createdBlockIds: Record<string, string>;
  documents?: Array<{ id: string; before: CanvasBlock | null; after: CanvasBlock | null }> };
export type ChatProposalUndoReceipt = { id: string; status: 'reverted' | 'partial'; reverted: string[]; skipped: Array<{ id: string; reason: string }> };

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
  onProposal?: (proposal: ChatProposal) => void;
  fetcher?: typeof fetch;
};

type Handlers = Pick<StreamOptions, 'onChunk' | 'onStep' | 'onReset' | 'onVerification' | 'onAnswerCanvas' | 'onNavigation' | 'onResearchPatch' | 'onPresentationChoice' | 'onProposal'>;

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
  if (status !== 'checking' && status !== 'supported' && status !== 'unsupported' && status !== 'unavailable' && status !== 'no_claims') return false;
  const verification = value as Verification;
  const source = (entry: VerificationSource) => typeof entry?.canvasId === 'string' && typeof entry.blockId === 'string' && typeof entry.title === 'string'
    && (entry.contentHash === undefined || typeof entry.contentHash === 'string')
    && (entry.excerpt === undefined || typeof entry.excerpt === 'string')
    && (entry.evidence === undefined || (entry.evidence !== null && typeof entry.evidence.claim === 'string' && typeof entry.evidence.passage === 'string'
      && (entry.evidence.passageKind === 'exact' || entry.evidence.passageKind === 'approximation')
      && Number.isFinite(Date.parse(entry.evidence.checkedAt))
      && entry.evidence.navigation?.kind === 'document' && typeof entry.evidence.navigation.blockId === 'string'));
  return (verification.sources === undefined || (Array.isArray(verification.sources) && verification.sources.every(source)))
    && (verification.checkedClaims === undefined || (Number.isInteger(verification.checkedClaims) && verification.checkedClaims >= 0))
    && (verification.totalClaims === undefined || (Number.isInteger(verification.totalClaims) && verification.totalClaims >= 0))
    && (verification.claims === undefined || (Array.isArray(verification.claims) && verification.claims.every(claim =>
      typeof claim?.text === 'string' && typeof claim.score === 'number' && Number.isFinite(claim.score)
      && typeof claim.supported === 'boolean' && (claim.source === undefined || source(claim.source)))));
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

function isChatProposal(value: unknown): value is ChatProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<ChatProposal>;
  return typeof proposal.id === 'string' && typeof proposal.canvasId === 'string' && proposal.status === 'pending'
    && Array.isArray(proposal.changes) && proposal.changes.every(change => typeof change.id === 'string'
      && ['create', 'edit', 'delete', 'move', 'link'].includes(change.type) && typeof change.blockId === 'string'
      && typeof change.title === 'string' && (change.before === null || typeof change.before === 'object')
      && (change.after === null || typeof change.after === 'object')
      && (change.canApply === undefined || typeof change.canApply === 'boolean'))
    && (proposal.expiresAt === undefined || typeof proposal.expiresAt === 'string');
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
  else if (event === 'chat_proposal') { if (isChatProposal(payload)) handlers.onProposal?.(payload); }
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
