import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CanvasStore } from './storage.js';
import type { AnswerCanvasResult, CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import type { ChatStreamSession, DeepAgentFactory } from './chat-agent.js';
import { pluginAllows } from './chat-input.js';
import { canvasTools, type CanvasToolsOptions } from './chat-tools.js';
import { createChatSession } from './chat-session.js';
import { chatPrompt } from './chat-stream-prompt.js';
import type { AgentConfiguration, ExternalTools, PreparedRequest } from './chat-stream-types.js';

function toolAllowed(tool: StructuredToolInterface, plugins: string[], canvasEnabled: boolean): boolean {
  if (!pluginAllows(tool.name, plugins)) return false;
  return tool.name !== 'draw_research_canvas' || canvasEnabled;
}

export function agentSession(store: CanvasStore, request: PreparedRequest, config: AgentConfiguration,
  answerCanvas: AnswerCanvasResult | null, external: ExternalTools, warnings: string[], close: () => Promise<void>,
  agentFactory: DeepAgentFactory, preparationSignal?: AbortSignal): ChatStreamSession {
  const navigationRequests: CanvasNavigationTarget[] = [];
  const researchPatches: ResearchCanvasPatch[] = [];
  const canvasEnabled = request.requestedResearchCanvas || answerCanvas?.surface === 'canvas';
  const toolContext: CanvasToolsOptions = { query: request.context.latest, navigationRequests,
    selectedSources: answerCanvas?.sources ?? [], researchPatches, draft: request.proposalDraft,
    currentView: request.currentView, signal: preparationSignal };
  const tools = canvasTools(store, request.canvasId, toolContext)
    .filter(tool => toolAllowed(tool, config.plugins, canvasEnabled));
  tools.push(...external.tools);
  const prompt = chatPrompt(request, config, answerCanvas, external.tools.length, canvasEnabled);
  const messages = request.history.map(item => item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content));
  return createChatSession({ ...request, store, providerName: config.providerName, answerCanvas, canvasEnabled, warnings, close, messages,
    model: config.settings.model, runAgent: agentFactory(config.model, tools, prompt), toolContext,
    navigationRequests, researchPatches, preparationSignal });
}
