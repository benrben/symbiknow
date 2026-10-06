import { type CanvasStore } from './storage.js';
import { defaultPlugins } from './settings.js';
import { externalTools } from './external-mcp.js';
import { ChatProposalDraft } from './chat-proposals.js';
import { chatContext, requiredString, conversationMessages, modelSettings, viewContext } from './chat-input.js';
import type { AgentConfiguration, ExternalTools, PreparedRequest } from './chat-stream-types.js';

export async function requestContext(store: CanvasStore, body: Record<string, unknown>): Promise<PreparedRequest> {
  const canvasId = requiredString(body.canvasId, 'canvasId');
  const activeCanvas = await store.getCanvas(canvasId);
  const proposalDraft = new ChatProposalDraft(store, canvasId, activeCanvas);
  const currentView = viewContext(body.viewContext, activeCanvas);
  const history = conversationMessages(body.messages);
  const context = chatContext(history);
  return { canvasId, activeCanvas, proposalDraft, currentView, history, context,
    requestedResearchCanvas: /\b(?:temporary|research)\s+canvas\b/iu.test(context.latest) };
}

export async function agentConfiguration(store: CanvasStore): Promise<AgentConfiguration> {
  const settings = await store.getSettings();
  const { secret, name: providerName, model } = await modelSettings(store);
  const plugins = settings.agentPlugins ?? defaultPlugins;
  return { settings, secret, providerName, model, plugins };
}

export function outsideTools(config: AgentConfiguration, warnings: string[], signal?: AbortSignal): Promise<ExternalTools> {
  if (!config.plugins.includes('external_mcp')) return Promise.resolve({ tools: [], close: async () => undefined });
  if (!config.secret.mcpServers?.some(server => server.enabled)) return Promise.resolve({ tools: [], close: async () => undefined });
  return externalTools(config.secret.mcpServers, config.secret.secrets ?? {}, message => warnings.push(message), signal);
}
