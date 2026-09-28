import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentPlugin, AgentProfile, ChatSettings, ExternalMcpServer, GroupBy, McpTokenInfo, ModelProvider } from '../shared/types.js';
import { hashToken } from './auth.js';
import { ApiError } from './errors.js';
import { defaultJevPolicy, effectiveJevPolicy, type ActionKind, type JevPolicy } from '../shared/policy.js';

export type StoredMcpToken = McpTokenInfo & { hash: string };

export type PrivateSettings = {
  provider?: ModelProvider;
  model: string;
  baseUrl?: string;
  systemPrompt: string;
  /** Legacy OpenRouter key from earlier versions. */
  apiKey: string;
  providerKeys?: Partial<Record<ModelProvider, string>>;
  jevApiKey: string;
  reviewers: string;
  workAreas: string;
  tagVocabulary?: string;
  jevPolicy?: Partial<JevPolicy>;
  agentProfile?: string;
  customProfiles?: AgentProfile[];
  agentPlugins?: AgentPlugin[];
  secrets?: Record<string, string>;
  mcpServers?: ExternalMcpServer[];
  mcpTokens?: StoredMcpToken[];
  groupBy?: GroupBy;
};

export const providers: ModelProvider[] = ['openrouter', 'openai', 'anthropic', 'custom'];
export const builtInProfiles = ['general', 'research', 'planner', 'builder'] as const;
export const allPlugins: AgentPlugin[] = ['document_read', 'document_write', 'jev_insights', 'tasks', 'external_mcp'];
export const mcpToolNames = [
  'list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'create_doc', 'edit_doc', 'delete_doc', 'move_block',
  'link_blocks', 'unlink_blocks', 'upload_file', 'download_file', 'claim_doc', 'release_doc', 'list_tasks',
  'create_task', 'update_task', 'claim_task', 'comment_task', 'analyze_canvas', 'find_duplicates',
  'merge_documents', 'undo_merge', 'connect_across_canvases', 'score_documents', 'run_workspace_automation',
  'list_versions', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision',
] as const;
export const readableMcpTools = new Set<string>(['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'download_file',
  'list_tasks', 'analyze_canvas', 'find_duplicates', 'connect_across_canvases', 'score_documents', 'list_versions']);
export const defaultPlugins: AgentPlugin[] = ['document_read', 'document_write', 'jev_insights', 'tasks', 'external_mcp'];
const groupings: GroupBy[] = ['work_area', 'purpose', 'lane'];
const secretName = /^[A-Z][A-Z0-9_]{0,63}$/;
const headerName = /^[A-Za-z0-9-]{1,64}$/;

const providerEnv: Record<ModelProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', custom: 'CUSTOM_MODEL_API_KEY',
};

export const defaultPrivateSettings: PrivateSettings = {
  provider: 'openrouter', model: '', systemPrompt: 'You are the SymbiKnow assistant. Help people and AI organize ideas and build knowledge together on the canvas. Use tools to check sources and make requested changes, and identify uncertain or unreviewed suggestions.',
  apiKey: '', jevApiKey: '', reviewers: '', workAreas: '',
};

export function activeProvider(settings: PrivateSettings): ModelProvider {
  return settings.provider && providers.includes(settings.provider) ? settings.provider : 'openrouter';
}

export function providerKey(settings: PrivateSettings, provider = activeProvider(settings)): string {
  const saved = settings.providerKeys?.[provider] || (provider === 'openrouter' ? settings.apiKey : '');
  return saved || process.env[providerEnv[provider]] || '';
}

/** A provider is ready when it has a key, or, for a self-hosted OpenAI-compatible server, a base URL. */
export function providerReady(settings: PrivateSettings, provider = activeProvider(settings)): boolean {
  return provider === 'custom' ? Boolean(settings.baseUrl) : Boolean(providerKey(settings, provider));
}

export function jevKey(settings: PrivateSettings): string {
  return settings.jevApiKey || process.env.TYPESAFE_API_KEY || '';
}

export function publicSettings(settings: PrivateSettings): ChatSettings {
  const provider = activeProvider(settings);
  return {
    provider, model: settings.model, systemPrompt: settings.systemPrompt,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    hasApiKey: providerReady(settings, provider),
    providerKeys: Object.fromEntries(providers.map(item => [item, providerReady(settings, item)])),
    hasJevApiKey: Boolean(jevKey(settings)),
    reviewers: settings.reviewers ?? '', workAreas: settings.workAreas ?? '', tagVocabulary: settings.tagVocabulary ?? '',
    jevPolicy: effectiveJevPolicy(settings.jevPolicy),
    ...(settings.agentProfile ? { agentProfile: settings.agentProfile } : {}),
    customProfiles: settings.customProfiles ?? [],
    ...(settings.agentPlugins ? { agentPlugins: settings.agentPlugins } : {}),
    secretNames: Object.keys(settings.secrets ?? {}).sort(),
    mcpServers: settings.mcpServers ?? [],
    mcpTokens: (settings.mcpTokens ?? []).map(({ id, name, access, preview, createdAt, lastUsedAt, allowedCanvasIds, tools }) => ({ id, name,
      access: access ?? 'write', preview, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(allowedCanvasIds ? { allowedCanvasIds } : {}), ...(tools ? { tools } : {}) })),
    groupBy: settings.groupBy ?? 'work_area',
  };
}

function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ApiError(400, `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`);
  }
  return value.trim();
}

function httpUrl(value: unknown, field: string): string {
  const url = text(value, field, 500, true);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ApiError(400, `${field} must be a valid URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ApiError(400, `${field} must use http or https`);
  return url.replace(/\/+$/, '');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || randomUUID().slice(0, 8);
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let index = 2; used.has(id); index++) id = `${base}-${index}`;
  used.add(id);
  return id;
}

function customProfiles(value: unknown): AgentProfile[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'customProfiles must contain at most 20 profiles');
  const used = new Set<string>(builtInProfiles);
  return value.map(item => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = text(entry.name, 'Profile name', 40, true);
    const requested = typeof entry.id === 'string' && /^custom-[a-z0-9-]{1,48}$/.test(entry.id) ? entry.id : `custom-${slug(name)}`;
    return { id: uniqueId(requested, used), name, instructions: text(entry.instructions, 'Profile instructions', 4000, true) };
  });
}

function agentProfile(value: unknown, profiles: AgentProfile[]): string {
  if (typeof value !== 'string' || !([...builtInProfiles] as string[]).concat(profiles.map(item => item.id)).includes(value)) {
    throw new ApiError(400, 'Unknown agent profile');
  }
  return value;
}

function plugins(value: unknown): AgentPlugin[] {
  if (!Array.isArray(value) || !value.every(item => allPlugins.includes(item))) throw new ApiError(400, 'Unknown agent plugin');
  return [...new Set(value)] as AgentPlugin[];
}

function secretsPatch(previous: Record<string, string>, value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'secrets must be an object');
  const next = { ...previous };
  for (const [name, secret] of Object.entries(value)) {
    if (!secretName.test(name)) throw new ApiError(400, 'Secret names use capital letters, digits, and underscores, starting with a letter');
    if (secret === null) { delete next[name]; continue; }
    next[name] = text(secret, `Secret ${name}`, 8192, true);
  }
  if (Object.keys(next).length > 50) throw new ApiError(400, 'Save at most 50 secrets');
  return next;
}

function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 10) {
    throw new ApiError(400, 'headers must be an object with at most 10 entries');
  }
  return Object.fromEntries(Object.entries(value).map(([name, header]) => {
    if (!headerName.test(name)) throw new ApiError(400, `Invalid header name: ${name}`);
    return [name, text(header, `Header ${name}`, 1000)];
  }));
}

function mcpServers(value: unknown, secrets: Record<string, string>): ExternalMcpServer[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'mcpServers must contain at most 20 servers');
  const used = new Set<string>();
  return value.map(item => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = text(entry.name, 'MCP server name', 40, true);
    const bearerSecret = entry.bearerSecret === undefined || entry.bearerSecret === '' ? undefined : text(entry.bearerSecret, 'bearerSecret', 64);
    if (bearerSecret && !(bearerSecret in secrets)) throw new ApiError(400, `Secret ${bearerSecret} is not saved`);
    const requested = typeof entry.id === 'string' && /^[a-z0-9-]{1,48}$/.test(entry.id) ? entry.id : slug(name);
    return { id: uniqueId(requested, used), name, url: httpUrl(entry.url, 'MCP server URL'), enabled: entry.enabled !== false,
      ...(bearerSecret ? { bearerSecret } : {}), headers: headers(entry.headers) };
  });
}

function keyValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new ApiError(400, `${field} must be a string`);
  return value.trim();
}

function providerKeys(previous: PrivateSettings, input: Record<string, unknown>, provider: ModelProvider) {
  const keys = { ...previous.providerKeys };
  if (!keys.openrouter && previous.apiKey) keys.openrouter = previous.apiKey;
  if (input.apiKey !== undefined) keys[provider] = keyValue(input.apiKey, 'apiKey');
  if (input.providerKeys !== undefined) {
    if (!input.providerKeys || typeof input.providerKeys !== 'object') throw new ApiError(400, 'providerKeys must be an object');
    for (const [name, value] of Object.entries(input.providerKeys)) {
      if (!providers.includes(name as ModelProvider)) throw new ApiError(400, `Unknown provider ${name}`);
      keys[name as ModelProvider] = keyValue(value, `${name} key`);
    }
  }
  return keys;
}

function optional<T>(input: Record<string, unknown>, field: string, previous: T, parse: (value: unknown) => T): T {
  return input[field] === undefined ? previous : parse(input[field]);
}

function policy(value: unknown): Partial<JevPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'jevPolicy must be an object');
  const result: Partial<JevPolicy> = {};
  for (const [kind, entry] of Object.entries(value)) {
    if (!(kind in defaultJevPolicy) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ApiError(400, `Unknown Jev policy action: ${kind}`);
    }
    const thresholds = entry as Record<string, unknown>;
    if (Object.keys(thresholds).some(key => key !== 'show' && key !== 'apply')) throw new ApiError(400, `Unknown threshold for ${kind}`);
    const baseline = defaultJevPolicy[kind as ActionKind];
    const show = thresholds.show ?? baseline.show;
    const apply = thresholds.apply ?? baseline.apply;
    if (typeof show !== 'number' || typeof apply !== 'number' || !Number.isFinite(show) || !Number.isFinite(apply)
      || show < 0 || apply > 1 || show > apply) throw new ApiError(400, `jevPolicy.${kind} must satisfy 0 ≤ show ≤ apply ≤ 1`);
    result[kind as ActionKind] = { show, apply };
  }
  return result;
}

export function updatedSettings(previous: PrivateSettings, input: Record<string, unknown>): PrivateSettings {
  const provider = optional(input, 'provider', activeProvider(previous), value => {
    if (!providers.includes(value as ModelProvider)) throw new ApiError(400, 'Unknown model provider');
    return value as ModelProvider;
  });
  const keys = providerKeys(previous, input, provider);
  const secrets = optional(input, 'secrets', previous.secrets ?? {}, value => secretsPatch(previous.secrets ?? {}, value));
  const profiles = optional(input, 'customProfiles', previous.customProfiles ?? [], customProfiles);
  const profile = optional(input, 'agentProfile', previous.agentProfile, value => agentProfile(value, profiles));
  const baseUrl = optional(input, 'baseUrl', previous.baseUrl, value => value === '' ? undefined : httpUrl(value, 'baseUrl'));
  return {
    provider,
    model: optional(input, 'model', previous.model, value => text(value, 'model', 120, true)),
    ...(baseUrl ? { baseUrl } : {}),
    systemPrompt: optional(input, 'systemPrompt', previous.systemPrompt, value => text(value, 'systemPrompt', 20_000)),
    apiKey: keys.openrouter ?? '',
    providerKeys: keys,
    jevApiKey: optional(input, 'jevApiKey', previous.jevApiKey ?? '', value => keyValue(value, 'jevApiKey')),
    reviewers: optional(input, 'reviewers', previous.reviewers ?? '', value => text(value, 'reviewers', 2000)),
    workAreas: optional(input, 'workAreas', previous.workAreas ?? '', value => text(value, 'workAreas', 2500)),
    tagVocabulary: optional(input, 'tagVocabulary', previous.tagVocabulary ?? '', value => text(value, 'tagVocabulary', 2500)),
    jevPolicy: optional(input, 'jevPolicy', previous.jevPolicy ?? {}, policy),
    ...(profile && (builtInProfiles.includes(profile as typeof builtInProfiles[number]) || profiles.some(item => item.id === profile))
      ? { agentProfile: profile } : {}),
    customProfiles: profiles,
    ...(optional(input, 'agentPlugins', previous.agentPlugins, plugins) ? { agentPlugins: optional(input, 'agentPlugins', previous.agentPlugins, plugins) } : {}),
    secrets,
    mcpServers: optional(input, 'mcpServers', previous.mcpServers ?? [], value => mcpServers(value, secrets))
      .filter(server => !server.bearerSecret || server.bearerSecret in secrets),
    mcpTokens: previous.mcpTokens ?? [],
    groupBy: optional(input, 'groupBy', previous.groupBy ?? 'work_area', value => {
      if (!groupings.includes(value as GroupBy)) throw new ApiError(400, 'groupBy must be work_area, purpose, or lane');
      return value as GroupBy;
    }),
  };
}

export function newMcpToken(name: unknown, access: unknown = 'read', scope?: { allowedCanvasIds?: unknown; tools?: unknown }): { token: string; stored: StoredMcpToken } {
  const label = text(name, 'Token name', 60, true);
  if (access !== 'read' && access !== 'propose' && access !== 'write') throw new ApiError(400, 'access must be read, propose, or write');
  const canvasIds = scope?.allowedCanvasIds;
  if (canvasIds !== undefined && (!Array.isArray(canvasIds) || !canvasIds.length || canvasIds.length > 100
    || canvasIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    || new Set(canvasIds).size !== canvasIds.length)) throw new ApiError(400, 'allowedCanvasIds must contain 1 to 100 distinct canvas IDs');
  const tools = scope?.tools;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.length || tools.length > mcpToolNames.length
    || tools.some(tool => typeof tool !== 'string' || !mcpToolNames.includes(tool as typeof mcpToolNames[number]))
    || new Set(tools).size !== tools.length)) throw new ApiError(400, 'tools must contain distinct supported MCP tool names');
  if (tools && (tools as string[]).some(tool => access !== 'write' && !readableMcpTools.has(tool)
    && !(access === 'propose' && tool === 'run_workspace_automation'))) {
    throw new ApiError(400, 'The selected tools exceed this token access level');
  }
  const token = `atm_${randomBytes(24).toString('base64url')}`;
  return { token, stored: { id: randomUUID(), name: label, access, hash: hashToken(token), preview: `…${token.slice(-4)}`,
    createdAt: new Date().toISOString(), ...(canvasIds ? { allowedCanvasIds: canvasIds as string[] } : {}),
    ...(tools ? { tools: tools as string[] } : {}) } };
}

/** Replace `${secret:NAME}` references and add the bearer secret for an outside MCP server. */
export function resolvedHeaders(server: ExternalMcpServer, secrets: Record<string, string>): Record<string, string> {
  const resolved = Object.fromEntries(Object.entries(server.headers ?? {}).map(([name, value]) => [name,
    value.replace(/\$\{secret:([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
      if (!(key in secrets)) throw new ApiError(400, `Secret ${key} is not saved`);
      return secrets[key];
    })]));
  if (server.bearerSecret) resolved.Authorization = `Bearer ${secrets[server.bearerSecret] ?? ''}`;
  return resolved;
}
