import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CanvasDocument, ChatSettings, AgentPlugin } from '../shared/types.js';
import type { ChatViewContext } from '../shared/answer-canvas.js';
import type { ChatContext, ConversationMessage } from './chat-input.js';
import type { ModelSettings } from './chat-agent-types.js';
import type { PrivateSettings } from './settings.js';

export type ChatStreamOptions = { signal?: AbortSignal; mcpApiBase?: string; mcpFetcher?: typeof fetch; mcpHeaders?: Record<string, string> };
export type PreparedRequest = {
  canvasId: string; conversationId: string; activeCanvas: CanvasDocument; currentView: ChatViewContext;
  history: ConversationMessage[]; context: ChatContext;
  requestedResearchCanvas: boolean;
};
export type AgentConfiguration = {
  settings: ChatSettings; secret: PrivateSettings; providerName: string;
  model: ModelSettings; plugins: AgentPlugin[];
};
export type ExternalTools = { tools: StructuredToolInterface[]; close: () => Promise<void> };
