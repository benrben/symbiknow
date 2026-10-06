import type { ChatSettings, ModelProvider } from '../shared/types';
import { allPlugins } from './settings-page-values';
import type { SettingsPayload } from './settings-page-types';

function agentFields(settings: ChatSettings) {
  return { agentProfile: settings.agentProfile ?? 'general', customProfiles: settings.customProfiles ?? [],
    agentPlugins: settings.agentPlugins?.filter(plugin => allPlugins.includes(plugin)) ?? allPlugins, mcpServers: settings.mcpServers ?? [] };
}

export function initialSettingsDraft(settings: ChatSettings) {
  return { provider: settings.provider ?? 'openrouter', model: settings.model, baseUrl: settings.baseUrl ?? '',
    systemPrompt: settings.systemPrompt, ...agentFields(settings) };
}

export type SettingsDraft = ReturnType<typeof initialSettingsDraft>;
export type UpdateSettingsDraft = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void;

export function withEditedProfiles(current: SettingsDraft, profiles: SettingsDraft['customProfiles']) {
  const removedSelection = current.customProfiles.some(profile => profile.id === current.agentProfile)
    && !profiles.some(profile => profile.id === current.agentProfile);
  return { ...current, customProfiles: profiles, agentProfile: removedSelection ? 'general' : current.agentProfile };
}

export function providerIsReady(settings: ChatSettings, provider: ModelProvider) {
  return provider === settings.provider ? settings.hasApiKey : Boolean(settings.providerKeys?.[provider]);
}

export function settingsSecretNames(settings: ChatSettings, secrets: Record<string, string | null>) {
  return [...new Set([...(settings.secretNames ?? []), ...Object.keys(secrets).filter(key => secrets[key] !== null)])]
    .filter(name => secrets[name] !== null).sort();
}

export function settingsPayload(draft: SettingsDraft, secretNames: string[], secrets: Record<string, string | null>): SettingsPayload {
  return { provider: draft.provider, model: draft.model.trim(), systemPrompt: draft.systemPrompt,
    agentProfile: draft.agentProfile, customProfiles: draft.customProfiles, agentPlugins: draft.agentPlugins,
    mcpServers: draft.mcpServers.filter(server => !server.bearerSecret || secretNames.includes(server.bearerSecret)),
    ...(draft.provider === 'custom' ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}) };
}
