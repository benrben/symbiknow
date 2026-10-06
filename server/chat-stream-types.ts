import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CanvasDocument, ChatSettings, AgentPlugin } from '../shared/types.js';
import type { ChatViewContext } from '../shared/answer-canvas.js';
import type { ChatContext, ConversationMessage } from './chat-input.js';
import type { ChatProposalDraft } from './chat-proposals.js';
import type { ModelSettings } from './chat-agent-types.js';
import type { PrivateSettings } from './settings.js';

export type ChatStreamOptions = { signal?: AbortSignal };
export type PreparedRequest = {
  canvasId: string; activeCanvas: CanvasDocument; proposalDraft: ChatProposalDraft; currentView: ChatViewContext;
  history: ConversationMessage[]; context: ChatContext;
  requestedResearchCanvas: boolean;
};
export type AgentConfiguration = {
  settings: ChatSettings; secret: PrivateSettings; providerName: string;
  model: ModelSettings; plugins: AgentPlugin[];
};
export type ExternalTools = { tools: StructuredToolInterface[]; close: () => Promise<void> };
