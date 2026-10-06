import { ApiError, type CanvasStore } from './storage.js';
import { chatModelConfig, providerNames } from './providers.js';
import { activeProvider } from './settings.js';

const profileInstructions: ReadonlyMap<string, string> = new Map([
  ['general', 'Help with any canvas task and explain the result clearly.'],
  ['research', 'Investigate relevant documents, compare evidence, and cite document titles in the answer.'],
  ['planner', 'Turn goals into ordered steps, dependencies, owners, and clear next actions.'],
  ['builder', 'Focus on concrete document edits and implementation details. Verify saved changes before reporting them.'],
]);

export function modelSetupMessage(name: string, setting: 'API key' | 'model'): string {
  const article = /^[AEIOU]/i.test(name) ? 'an' : 'a';
  return `Set ${article} ${name} ${setting} in Settings before using chat`;
}

export async function modelSettings(store: CanvasStore) {
  const secret = await store.secretSettings();
  const provider = activeProvider(secret);
  const name = providerNames[provider];
  if (provider !== 'custom' && !(await store.getApiKey())) throw new ApiError(400, modelSetupMessage(name, 'API key'));
  if (!secret.model) throw new ApiError(400, modelSetupMessage(name, 'model'));
  const config = chatModelConfig(secret);
  return { secret, name, model: { model: config.model, apiKey: config.apiKey, baseURL: config.baseURL, headers: config.headers, provider } };
}

export function profileText(settings: Awaited<ReturnType<CanvasStore['getSettings']>>): string {
  const id = settings.agentProfile ?? 'general';
  return profileInstructions.get(id) ?? settings.customProfiles?.find(profile => profile.id === id)?.instructions ?? profileInstructions.get('general')!;
}

