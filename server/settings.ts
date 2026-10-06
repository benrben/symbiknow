import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentPlugin, AgentProfile, ChatSettings, ExternalMcpServer, GroupBy, McpTokenInfo, ModelProvider } from '../shared/types.js';
import { hashToken } from './auth.js';
import { ApiError } from './errors.js';

export type StoredMcpToken = McpTokenInfo & { hash: string };

export type PrivateSettings = {
  provider?: ModelProvider;
  model: string;
  baseUrl?: string;
  systemPrompt: string;
  /** Legacy OpenRouter key from earlier versions. */
  apiKey: string;
  providerKeys?: Partial<Record<ModelProvider, string>>;
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
export const allPlugins: AgentPlugin[] = ['document_read', 'document_write', 'tasks', 'external_mcp'];
export const mcpToolNames = [
  'ask_symbi', 'symbi_reflex',
  'list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'create_doc', 'import_documents', 'edit_doc', 'delete_doc', 'move_block',
  'link_blocks', 'unlink_blocks', 'upload_file', 'download_file', 'claim_doc', 'release_doc', 'list_tasks',
  'create_task', 'update_task', 'delete_task', 'task_history', 'undo_task', 'claim_task', 'comment_task',
  'list_versions', 'create_branch', 'delete_branch', 'switch_branch', 'merge_branch', 'restore_revision',
  'jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_do', 'jev_job', 'jev_propose',
] as const;
export const readableMcpTools = new Set<string>(['ask_symbi', 'symbi_reflex', 'list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'download_file',
  'list_tasks', 'task_history', 'list_versions', 'jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_job',]);
export const defaultPlugins: AgentPlugin[] = ['document_read', 'document_write', 'tasks', 'external_mcp'];
const retiredSettings = new Set(['jevApiKey', 'reviewers', 'workAreas', 'tagVocabulary', 'jevPolicy']);
const groupings: GroupBy[] = ['work_area', 'purpose', 'lane'];
const secretName = /^[A-Z][A-Z0-9_]{0,63}$/;
const headerName = /^[A-Za-z0-9-]{1,64}$/;

const providerEnv: Record<ModelProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', custom: 'CUSTOM_MODEL_API_KEY',
};

export const defaultPrivateSettings: PrivateSettings = {
  provider: 'openrouter', model: '', systemPrompt: 'You are the SymbiKnow assistant. Help people and AI organize ideas and build knowledge together on the canvas. Use tools to check sources and make requested changes, and identify uncertain or unreviewed suggestions.',
  apiKey: '',
};

export function activeProvider(settings: PrivateSettings): ModelProvider {
  return settings.provider && providers.includes(settings.provider) ? settings.provider : 'openrouter';
}

export function providerKey(settings: PrivateSettings, provider = activeProvider(settings)): string {
  return savedProviderKey(settings, provider) || process.env[providerEnv[provider]] || '';
}

function savedProviderKey(settings: PrivateSettings, provider: ModelProvider): string {
  return settings.providerKeys?.[provider] || (provider === 'openrouter' ? settings.apiKey : '');
}

/** A provider is ready when it has a key, or, for a self-hosted OpenAI-compatible server, a base URL. */
export function providerReady(settings: PrivateSettings, provider = activeProvider(settings)): boolean {
  return provider === 'custom' ? Boolean(settings.baseUrl) : Boolean(providerKey(settings, provider));
}

export function publicSettings(settings: PrivateSettings): ChatSettings {
  const provider = activeProvider(settings);
  return {
    ...publicModelSettings(settings, provider),
    ...publicAgentSettings(settings),
    ...publicMcpSettings(settings),
    groupBy: settings.groupBy ?? 'work_area',
  };
}

function publicModelSettings(settings: PrivateSettings, provider: ModelProvider) {
  return {
    provider, model: settings.model, systemPrompt: settings.systemPrompt,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    hasApiKey: providerReady(settings, provider),
    providerKeys: Object.fromEntries(providers.map(item => [item, providerReady(settings, item)])),
  };
}

function publicAgentSettings(settings: PrivateSettings) {
  return {
    ...(settings.agentProfile ? { agentProfile: settings.agentProfile } : {}),
    customProfiles: settings.customProfiles ?? [],
    ...(settings.agentPlugins ? { agentPlugins: supportedPlugins(settings.agentPlugins) } : {}),
  };
}

function publicMcpSettings(settings: PrivateSettings) {
  return {
    secretNames: Object.keys(settings.secrets ?? {}).sort(),
    mcpServers: settings.mcpServers ?? [],
    mcpTokens: (settings.mcpTokens ?? []).map(({ id, name, access, preview, createdAt, lastUsedAt, allowedCanvasIds, tools }) => ({ id, name,
      access: access ?? 'write', preview, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(allowedCanvasIds ? { allowedCanvasIds } : {}), ...(tools ? { tools } : {}) })),
  };
}

function text(value: unknown, field: string, max: number, required = false): string {
  if (!validText(value, max, required)) {
    throw new ApiError(400, `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`);
  }
  return (value as string).trim();
}

function validText(value: unknown, max: number, required: boolean): boolean {
  return typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()));
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
  const entries = object(value, 'secrets must be an object');
  const next = { ...previous };
  for (const [name, secret] of Object.entries(entries)) patchSecret(next, name, secret);
  if (Object.keys(next).length > 50) throw new ApiError(400, 'Save at most 50 secrets');
  return next;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, message);
  return value as Record<string, unknown>;
}

function patchSecret(next: Record<string, string>, name: string, secret: unknown): void {
  if (!secretName.test(name)) throw new ApiError(400, 'Secret names use capital letters, digits, and underscores, starting with a letter');
  if (secret === null) { delete next[name]; return; }
  next[name] = text(secret, `Secret ${name}`, 8192, true);
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
  return value.map(item => mcpServer(item, secrets, used));
}

function mcpServer(item: unknown, secrets: Record<string, string>, used: Set<string>): ExternalMcpServer {
  const entry = (item ?? {}) as Record<string, unknown>;
  const name = text(entry.name, 'MCP server name', 40, true);
  const bearerSecret = serverBearerSecret(entry, secrets);
  const requested = typeof entry.id === 'string' && /^[a-z0-9-]{1,48}$/.test(entry.id) ? entry.id : slug(name);
  return { id: uniqueId(requested, used), name, url: httpUrl(entry.url, 'MCP server URL'), enabled: entry.enabled !== false,
    ...(bearerSecret ? { bearerSecret } : {}), headers: headers(entry.headers) };
}

function serverBearerSecret(entry: Record<string, unknown>, secrets: Record<string, string>): string | undefined {
  if (entry.bearerSecret === undefined || entry.bearerSecret === '') return undefined;
  const name = text(entry.bearerSecret, 'bearerSecret', 64);
  if (name && !(name in secrets)) throw new ApiError(400, `Secret ${name} is not saved`);
  return name;
}

function keyValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new ApiError(400, `${field} must be a string`);
  return value.trim();
}

function providerKeys(previous: PrivateSettings, input: Record<string, unknown>, provider: ModelProvider) {
  const keys = { ...previous.providerKeys };
  migrateLegacyKey(keys, previous.apiKey);
  if (input.apiKey !== undefined) keys[provider] = keyValue(input.apiKey, 'apiKey');
  if (input.providerKeys !== undefined) patchProviderKeys(keys, input.providerKeys);
  return keys;
}

function migrateLegacyKey(keys: Partial<Record<ModelProvider, string>>, legacy: string): void {
  if (!keys.openrouter && legacy) keys.openrouter = legacy;
}

function patchProviderKeys(keys: Partial<Record<ModelProvider, string>>, value: unknown): void {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'providerKeys must be an object');
  for (const [name, key] of Object.entries(value)) {
    if (!providers.includes(name as ModelProvider)) throw new ApiError(400, `Unknown provider ${name}`);
    keys[name as ModelProvider] = keyValue(key, `${name} key`);
  }
}

function optional<T>(input: Record<string, unknown>, field: string, previous: T, parse: (value: unknown) => T): T {
  return input[field] === undefined ? previous : parse(input[field]);
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
    // Retain old private metadata without exposing or accepting updates to removed features.
    ...Object.fromEntries(Object.entries(previous).filter(([field]) => retiredSettings.has(field))),
    ...updatedModelSettings(previous, input, provider, keys, baseUrl),
    ...updatedAgentSettings(previous, input, profiles, profile),
    ...updatedConnectionSettings(previous, input, secrets),
  };
}

function updatedModelSettings(previous: PrivateSettings, input: Record<string, unknown>, provider: ModelProvider,
  keys: Partial<Record<ModelProvider, string>>, baseUrl: string | undefined) {
  return {
    provider,
    model: optional(input, 'model', previous.model, value => text(value, 'model', 120, true)),
    ...(baseUrl ? { baseUrl } : {}),
    systemPrompt: optional(input, 'systemPrompt', previous.systemPrompt, value => text(value, 'systemPrompt', 20_000)),
    apiKey: keys.openrouter ?? '',
    providerKeys: keys,
  };
}

function supportedPlugins(value: AgentPlugin[]): AgentPlugin[] { return value.filter(item => allPlugins.includes(item)); }

function updatedAgentSettings(previous: PrivateSettings, input: Record<string, unknown>, profiles: AgentProfile[], profile: string | undefined) {
  const selected = optional(input, 'agentPlugins', previous.agentPlugins, plugins);
  return {
    ...(profile && (builtInProfiles.includes(profile as typeof builtInProfiles[number]) || profiles.some(item => item.id === profile))
      ? { agentProfile: profile } : {}),
    customProfiles: profiles,
    ...(selected ? { agentPlugins: supportedPlugins(selected) } : {}),
  };
}

function updatedConnectionSettings(previous: PrivateSettings, input: Record<string, unknown>, secrets: Record<string, string>) {
  return {
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
  const level = tokenAccess(access);
  const canvasIds = distinctScope(scope?.allowedCanvasIds, 100, validCanvasId, 'allowedCanvasIds must contain 1 to 100 distinct canvas IDs');
  const tools = distinctScope(scope?.tools, mcpToolNames.length, validToolName, 'tools must contain distinct supported MCP tool names');
  validateToolAccess(tools, level);
  const token = `atm_${randomBytes(24).toString('base64url')}`;
  return { token, stored: { id: randomUUID(), name: label, access: level, hash: hashToken(token), preview: `…${token.slice(-4)}`,
    createdAt: new Date().toISOString(), ...(canvasIds ? { allowedCanvasIds: canvasIds } : {}),
    ...(tools ? { tools } : {}) } };
}

type TokenAccess = 'read' | 'propose' | 'write';

function tokenAccess(access: unknown): TokenAccess {
  if (access !== 'read' && access !== 'propose' && access !== 'write') throw new ApiError(400, 'access must be read, propose, or write');
  return access;
}

function distinctScope(value: unknown, max: number, valid: (item: unknown) => boolean, message: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!validScope(value, max, valid)) throw new ApiError(400, message);
  return value as string[];
}

function validScope(value: unknown, max: number, valid: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= max
    && value.every(valid) && new Set(value).size === value.length;
}

function validCanvasId(id: unknown): boolean {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function validToolName(tool: unknown): boolean {
  return typeof tool === 'string' && mcpToolNames.includes(tool as typeof mcpToolNames[number]);
}

function validateToolAccess(tools: string[] | undefined, access: TokenAccess): void {
  if (tools?.some(tool => access !== 'write' && !readableMcpTools.has(tool) && !(access === 'propose' && tool === 'jev_propose'))) {
    throw new ApiError(400, 'The selected tools exceed this token access level');
  }
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
