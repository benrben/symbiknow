import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { CanvasStore } from './storage.js';
import type { CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas.js';
import type { ChatStreamSession, DeepAgentFactory } from './chat-agent.js';
import { createStoreApiFetcher } from './api-inprocess.js';
import { symbiApiHeaders } from './jev-api-principal.js';
import { conversationWorkspace } from './agent-workspace.js';
import { symbiMcpTools, type SymbiToolContext } from './symbi-mcp-client.js';
import { createChatSession } from './chat-session.js';
import { chatMcpSources } from './chat-mcp-sources.js';
import { chatPrompt } from './chat-stream-prompt.js';
import type { AgentConfiguration, ChatStreamOptions, ExternalTools, PreparedRequest } from './chat-stream-types.js';

export async function agentSession(store: CanvasStore, request: PreparedRequest, config: AgentConfiguration,
  external: ExternalTools, warnings: string[], close: () => Promise<void>,
  agentFactory: DeepAgentFactory, options: ChatStreamOptions = {}): Promise<ChatStreamSession> {
  const navigationRequests: CanvasNavigationTarget[] = [];
  const researchPatches: ResearchCanvasPatch[] = [];
  const workdir = await conversationWorkspace(store.root, request.conversationId);
  const toolContext: SymbiToolContext = { store, canvasId: request.canvasId, currentView: request.currentView, query: request.context.latest,
    navigationRequests, researchPatches, proposals: [], workdir, signal: options.signal };
  const canonical = await symbiMcpTools(toolContext, { ...options,
    mcpApiBase: options.mcpApiBase ?? 'http://symbi.internal/api',
    mcpFetcher: options.mcpFetcher ?? createStoreApiFetcher(store), mcpHeaders: options.mcpHeaders ?? symbiApiHeaders() });
  const cleanup = async () => { await Promise.all([canonical.close(), close()]); };
  try {
    const answerCanvas = await chatMcpSources(canonical.tools, request, options.signal);
    // Prepared retrieval already has its own source records; collect later agent reads separately.
    toolContext.readSources = [];
    const canvasEnabled = request.requestedResearchCanvas || answerCanvas?.surface === 'canvas';
    const tools = [...canonical.tools, ...external.tools];
    const prompt = chatPrompt(request, config, answerCanvas, external.tools.length, canvasEnabled);
    const messages = request.history.map(item => item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content));
    return createChatSession({ ...request, store, providerName: config.providerName, answerCanvas, canvasEnabled, warnings,
      close: cleanup, messages, model: config.settings.model, runAgent: agentFactory(config.model, tools, prompt, { workdir }),
      toolContext, navigationRequests, researchPatches, preparationSignal: options.signal });
  } catch (error) { await canonical.close(); throw error; }
}
