import type { BaseMessage } from '@langchain/core/messages';
import type { AnswerCanvasResult, CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import { patchFromMarkdown } from '../shared/research-patch.js';
import type { CanvasStore } from './storage.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { finalAnswer, textPieces, agentProgress, collectSnapshot,
  type AgentRun, type ChatStreamSession, type ChatStreamEvent, type ProgressState } from './chat-agent.js';
import type { ChatContext } from './chat-input.js';
import type { CanvasToolsOptions } from './chat-tools.js';
import { combinedSignal } from './chat-cancellation.js';

export type SessionContext = {
  model: string; providerName: string; messages: BaseMessage[]; runAgent: AgentRun; preparationSignal?: AbortSignal;
  toolContext: CanvasToolsOptions; proposalDraft: ChatProposalDraft;
  store: CanvasStore; canvasId: string; context: ChatContext;
  answerCanvas: AnswerCanvasResult | null; canvasEnabled: boolean; warnings: string[];
  navigationRequests: CanvasNavigationTarget[]; researchPatches: ResearchCanvasPatch[]; close: () => Promise<void>;
};

function patchesForAnswer(session: SessionContext, answer: string): ResearchCanvasPatch[] {
  if (!session.canvasEnabled) return [];
  if (session.researchPatches.length) return session.researchPatches;
  return [patchFromMarkdown(session.context.latest, answer, session.answerCanvas?.sources ?? [])];
}

function* refreshedAnswer(answer: string, progress: ProgressState): Generator<ChatStreamEvent> {
  if (progress.streamed.trim() === answer.trim()) return;
  if (progress.streamed) yield { kind: 'reset' };
  for (const content of textPieces(answer)) yield { kind: 'text', content };
}

function* prelude(session: SessionContext): Generator<ChatStreamEvent> {
  if (session.canvasEnabled && session.answerCanvas?.sources.length) yield { kind: 'answer_canvas', canvas: session.answerCanvas };
  for (const message of session.warnings) yield { kind: 'step', step: { type: 'thinking', message } };
}

async function* completedEvents(session: SessionContext, answer: string, progress: ProgressState): AsyncGenerator<ChatStreamEvent> {
  const proposal = session.proposalDraft.publish();
  if (proposal) yield { kind: 'proposal', proposal };
  for (const target of session.navigationRequests) yield { kind: 'navigate', target };
  const patches = patchesForAnswer(session, answer);
  for (const patch of patches) yield { kind: 'research_patch', patch };
  yield* refreshedAnswer(answer, progress);
}

export function createChatSession(session: SessionContext): ChatStreamSession {
  const runSignal = (signal: AbortSignal) => {
    const combined = combinedSignal(session.preparationSignal, signal)!;
    session.toolContext.signal = combined;
    return combined;
  };
  return {
    model: session.model,
    async *tokens(requestSignal) {
      const signal = runSignal(requestSignal);
      try {
        if (signal.aborted) return;
        const latest = await collectSnapshot(session.runAgent, session.messages, signal, session.providerName);
        if (signal.aborted) return;
        session.proposalDraft.publish();
        const answer = finalAnswer(latest, session.providerName);
        for (const piece of textPieces(answer)) {
          if (signal.aborted) return;
          yield piece;
        }
      } finally { await session.close(); }
    },
    async *events(requestSignal) {
      const signal = runSignal(requestSignal);
      try {
        if (signal.aborted) return;
        yield* prelude(session);
        const progress: ProgressState = { seen: 0, started: false, streamed: '' };
        const latest = yield* agentProgress(session.runAgent, session.messages, signal, session.providerName, progress);
        if (signal.aborted) return;
        yield* completedEvents(session, finalAnswer(latest, session.providerName), progress);
      } finally { await session.close(); }
    },
  };
}
