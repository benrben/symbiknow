import type { ModelProvider } from '../shared/types.js';
import { ApiError } from './errors.js';
import { activeProvider, providerKey, providers, type PrivateSettings } from './settings.js';

export type ModelOption = { id: string; name: string; tools?: boolean; context?: number };

export const providerNames: Record<ModelProvider, string> = {
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', custom: 'OpenAI-compatible',
};

const baseUrls: Record<Exclude<ModelProvider, 'custom'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  // Anthropic's OpenAI SDK compatibility endpoint supports chat completions, streaming, and tools.
  anthropic: 'https://api.anthropic.com/v1/',
};

export type ChatModelConfig = { provider: ModelProvider; model: string; apiKey: string; baseURL: string; headers: Record<string, string> };

export function chatModelConfig(settings: PrivateSettings): ChatModelConfig {
  const provider = activeProvider(settings);
  const baseURL = provider === 'custom' ? settings.baseUrl ?? '' : baseUrls[provider];
  if (!baseURL) throw new ApiError(400, 'Set a base URL for the OpenAI-compatible provider in Settings');
  const apiKey = providerKey(settings, provider) || (provider === 'custom' ? 'not-needed' : '');
  if (!apiKey) throw new ApiError(400, `Set a ${providerNames[provider]} API key in Settings before using chat`);
  if (!settings.model) throw new ApiError(400, `Choose a ${providerNames[provider]} model in Settings before using chat`);
  const headers: Record<string, string> = provider === 'openrouter'
    ? { 'HTTP-Referer': process.env.PUBLIC_URL || 'http://localhost:5173', 'X-Title': 'SymbiKnow' } : {};
  return { provider, model: settings.model, apiKey, baseURL, headers };
}

const cache = new Map<string, { at: number; models: ModelOption[] }>();

async function getJson(url: string, headers: Record<string, string>, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetcher(url, { headers, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ApiError(502, 'Could not reach the model provider'); }
  if (response.status === 401 || response.status === 403) throw new ApiError(502, 'The provider rejected the API key. Save a valid key first.');
  if (!response.ok) throw new ApiError(502, `The provider returned ${response.status} when listing models`);
  return await response.json() as Record<string, unknown>;
}

type RawModel = Record<string, unknown>;

function rows(payload: Record<string, unknown>): RawModel[] {
  return Array.isArray(payload.data) ? payload.data.filter((item): item is RawModel => Boolean(item) && typeof item === 'object') : [];
}

const chatModel = /^(gpt-|o\d|chatgpt-)/;

async function fetchModels(settings: PrivateSettings, provider: ModelProvider, fetcher: typeof fetch): Promise<ModelOption[]> {
  const key = providerKey(settings, provider);
  if (provider === 'openrouter') {
    return rows(await getJson(`${baseUrls.openrouter}/models`, {}, fetcher)).map(item => ({
      id: String(item.id), name: String(item.name ?? item.id), context: Number(item.context_length) || undefined,
      tools: Array.isArray(item.supported_parameters) ? item.supported_parameters.includes('tools') : undefined,
    }));
  }
  if (provider === 'anthropic') {
    if (!key) throw new ApiError(400, 'Save an Anthropic API key to load its models');
    return rows(await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, fetcher))
      .map(item => ({ id: String(item.id), name: String(item.display_name ?? item.id), tools: true }));
  }
  const base = provider === 'custom' ? settings.baseUrl : baseUrls.openai;
  if (!base) throw new ApiError(400, 'Save a base URL to load models');
  if (provider === 'openai' && !key) throw new ApiError(400, 'Save an OpenAI API key to load its models');
  const models = rows(await getJson(`${base.replace(/\/+$/, '')}/models`, key ? { authorization: `Bearer ${key}` } : {}, fetcher))
    .map(item => ({ id: String(item.id), name: String(item.id) }));
  return provider === 'openai' ? models.filter(item => chatModel.test(item.id)).map(item => ({ ...item, tools: true })) : models;
}

export async function listModels(settings: PrivateSettings, requested: unknown, fetcher: typeof fetch = fetch): Promise<ModelOption[]> {
  const provider = requested === undefined || requested === null || requested === '' ? activeProvider(settings) : requested as ModelProvider;
  if (!providers.includes(provider)) throw new ApiError(400, 'Unknown model provider');
  const cacheKey = `${provider}:${provider === 'custom' ? settings.baseUrl : ''}:${providerKey(settings, provider).slice(-6)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models;
  const models = (await fetchModels(settings, provider, fetcher)).sort((a, b) => a.id.localeCompare(b.id));
  cache.set(cacheKey, { at: Date.now(), models });
  return models;
}
