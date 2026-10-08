import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ModelProvider } from '../shared/types.js';
import type { AnswerCanvasResult, CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import type { ChatProposal } from './chat-proposals.js';

export type ModelSettings = { model: string; apiKey: string; baseURL?: string; headers?: Record<string, string>; provider?: ModelProvider };
export type AgentSnapshot = { messages?: BaseMessage[] };
/** A Deep Agents stream item: a plain `values` snapshot, or a `[mode, payload]` pair when several stream modes are requested. */
export type AgentStreamItem = AgentSnapshot | ['values', AgentSnapshot] | ['messages', [BaseMessage, Record<string, unknown>]] | [string, unknown];
export type AgentRun = (messages: BaseMessage[], signal: AbortSignal) => Promise<AsyncIterable<AgentStreamItem>> | AsyncIterable<AgentStreamItem>;
export type DeepAgentFactory = (settings: ModelSettings, tools: StructuredToolInterface[], systemPrompt: string, environment?: { workdir: string }) => AgentRun;

export type ChatAgentStep = { type: 'thinking' | 'tool_start' | 'tool_end'; id?: string; name?: string; message: string };
export type ChatStreamEvent = { kind: 'text'; content: string } | { kind: 'step'; step: ChatAgentStep }
  | { kind: 'reset' }
  | { kind: 'answer_canvas'; canvas: AnswerCanvasResult } | { kind: 'navigate'; target: CanvasNavigationTarget }
  | { kind: 'research_patch'; patch: ResearchCanvasPatch }
  | { kind: 'proposal'; proposal: ChatProposal };

export type ProgressState = { seen: number; started: boolean; streamed: string };

export interface ChatStreamSession {
  model: string;
  tokens(signal: AbortSignal): AsyncGenerator<string>;
  events?(signal: AbortSignal): AsyncGenerator<ChatStreamEvent>;
}
