import { ApiError, CanvasStore } from './storage.js';

export { modelSettings, profileText } from './chat-agent-configuration.js';
export { viewContext, viewDescription } from './chat-view-context.js';

export type ConversationRole = 'user' | 'assistant';
export type ConversationMessage = { role: ConversationRole; content: string };
export type ChatContext = { latest: string; previousAssistant: string; previousUser: string };

export function chatContext(history: ConversationMessage[]): ChatContext {
  const previous = history.slice(0, -1).reverse();
  return {
    latest: history.at(-1)!.content,
    previousAssistant: previous.find(message => message.role === 'assistant')?.content.slice(0, 1_500) ?? '',
    previousUser: previous.find(message => message.role === 'user')?.content.slice(0, 1_500) ?? '',
  };
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${name} must be a string`);
  return value.trim();
}

export function messageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string).join('\n');
}

function messageRole(value: unknown): ConversationRole | null {
  if (!value || typeof value !== 'object') return null;
  const role = (value as Record<string, unknown>).role;
  return role === 'user' || role === 'assistant' ? role : null;
}

function normalizedMessage(value: unknown): ConversationMessage | null {
  const role = messageRole(value);
  if (!role) return null;
  const content = messageContent((value as Record<string, unknown>).content);
  if (!content) return null;
  if (content.length > 20_000) throw new ApiError(400, 'Chat message is too long');
  return { role, content };
}

export function conversationMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError(400, 'messages must contain 1 to 100 messages');
  }
  const messages = value.map(normalizedMessage).filter((item): item is ConversationMessage => item !== null).slice(-30);
  if (messages.at(-1)?.role !== 'user') throw new ApiError(400, 'The last chat message must be from the user');
  return messages;
}

export function findBlock(store: CanvasStore, canvasId: string, blockId: string) {
  return store.getCanvas(canvasId).then(canvas => {
    const block = canvas.blocks.find(item => item.id === blockId);
    if (!block) throw new ApiError(404, 'Block not found');
    return block;
  });
}

const navigationTools = ['show_doc_on_canvas', 'show_group_on_canvas', 'draw_research_canvas'];

const toolPlugins = new Map<string, string>([
  ...['search_docs', 'read_doc', ...navigationTools].map(name => [name, 'document_read'] as [string, string]),
  ...['create_doc', 'edit_doc', 'move_block', 'link_blocks', 'delete_doc'].map(name => [name, 'document_write'] as [string, string]),
  ...['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox'].map(name => [name, 'document_read'] as [string, string]),
  ['jev_do', 'document_write'],
]);

function pluginForTool(name: string): string | undefined {
  if (name.endsWith('_task') || name === 'list_tasks') return 'tasks';
  return toolPlugins.get(name);
}

export function pluginAllows(name: string, enabled: string[]): boolean {
  if (name === 'draw_research_canvas') return true;
  const plugin = pluginForTool(name);
  return plugin !== undefined && enabled.includes(plugin);
}

export function asksForSources(request: string): boolean {
  if (/^\s*(?:open|go to|navigate to|take me to|focus on|show me (?:the )?(?:document|group|canvas))\b/iu.test(request)) return false;
  return /\?\s*$|^\s*(?:what|why|how|which|where|who|when|is|are|do|does|can|could|summari[sz]e|explain|compare|find|show me|tell me|answer|research|visuali[sz]e|map|explore|help|look into|work on)\b/iu.test(request);
}
