import type { ReactNode } from 'react';
import { Activity, Bot, KeyRound, PlugZap, Puzzle, Server, Sparkles } from 'lucide-react';
import type { AgentPlugin, AgentProfile, ModelProvider } from '../shared/types';
import type { SectionId } from './settings-page-types';

export const sections: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'models', label: 'Models', icon: <Sparkles size={15}/> },
  { id: 'agents', label: 'Agents & secrets', icon: <Bot size={15}/> },
  { id: 'secrets', label: 'Secrets', icon: <KeyRound size={15}/> },
  { id: 'servers', label: 'External tools', icon: <Server size={15}/> },
  { id: 'connect', label: 'Workspace access', icon: <PlugZap size={15}/> },
  { id: 'activity', label: 'Agent activity', icon: <Activity size={15}/> },
  { id: 'plugins', label: 'Plugins & loaders', icon: <Puzzle size={15}/> },
  { id: 'jev', label: 'Symbi Reflex', icon: <Bot size={15}/> },
];

export const providerInfo: Record<ModelProvider, { name: string; glyph: string; description: string; placeholder: string }> = {
  openrouter: { name: 'OpenRouter', glyph: '↗', description: 'Hundreds of models behind one key', placeholder: 'sk-or-v1-…' },
  openai: { name: 'OpenAI', glyph: '◎', description: 'GPT and o-series models', placeholder: 'sk-…' },
  anthropic: { name: 'Anthropic', glyph: 'A', description: 'Claude models', placeholder: 'sk-ant-…' },
  custom: { name: 'OpenAI-compatible', glyph: '⌘', description: 'Ollama, vLLM, LM Studio, or a gateway', placeholder: 'Optional' },
};

export const builtInProfiles: AgentProfile[] = [
  { id: 'general', name: 'General assistant', instructions: 'Help with any canvas task and explain the result clearly.' },
  { id: 'research', name: 'Researcher', instructions: 'Investigate relevant documents, compare evidence, and cite document titles.' },
  { id: 'planner', name: 'Planner', instructions: 'Turn goals into ordered steps, dependencies, owners, and next actions.' },
  { id: 'builder', name: 'Builder', instructions: 'Focus on concrete document edits and verify saved changes.' },
];

export const pluginInfo: Array<{ id: AgentPlugin; title: string; detail: string }> = [
  { id: 'document_read', title: 'Read documents', detail: 'Search and read canvas files.' },
  { id: 'document_write', title: 'Edit documents', detail: 'Create, edit, move, link, and delete files when requested.' },
  { id: 'external_mcp', title: 'Outside MCP servers', detail: 'Use tools from the MCP servers you connect below.' },
];

export const allPlugins = pluginInfo.map(item => item.id);

export function uniqueSettingsId(base: string, entries: Array<{ id: string }>) {
  let id = base; let suffix = 2;
  const used = new Set(entries.map(entry => entry.id));
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}
