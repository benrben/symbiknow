import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPrivateSettings, type PrivateSettings } from './settings.js';
import type { ModelProvider } from '../shared/types.js';

let providers: typeof import('./providers.js');
beforeEach(async () => {
  vi.resetModules();
  providers = await import('./providers.js');
  for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CUSTOM_MODEL_API_KEY']) vi.stubEnv(key, '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function settings(input: Partial<PrivateSettings> = {}): PrivateSettings {
  return { ...defaultPrivateSettings, model: 'fixture', provider: 'custom', baseUrl: 'http://localhost:1234/v1', ...input };
}
const json = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => Response.json(body, { status }));

describe('model catalog boundary', () => {
  it('keeps cached catalogs separate for keys sharing the same suffix', async () => {
    const first = json({ data: [{ id: 'account-one' }] });
    const second = json({ data: [{ id: 'account-two' }] });
    expect(await providers.listModels(settings({ providerKeys: { custom: 'first-same-suffix' } }), null, first))
      .toEqual([{ id: 'account-one', name: 'account-one' }]);
    expect(await providers.listModels(settings({ providerKeys: { custom: 'second-same-suffix' } }), null, second))
      .toEqual([{ id: 'account-two', name: 'account-two' }]);
    expect(second).toHaveBeenCalledOnce();
  });

  it.each(['invalid json', 'null', '[]'])('classifies malformed upstream catalogs as provider failures: %s', async body => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(providers.listModels(settings(), 'custom', fetcher)).rejects.toMatchObject({ status: 502 });
  });

  it('lists public OpenRouter names, capabilities and context without requiring a key', async () => {
    const fetcher = json({ data: [null, false, 'invalid',
      { id: 'z', name: 'Named model', context_length: 1000, supported_parameters: ['tools'] },
      { id: 'a', context_length: 0, supported_parameters: ['temperature'] }, { id: 'b' }] });
    expect(await providers.listModels(settings(), 'openrouter', fetcher)).toEqual([
      { id: 'a', name: 'a', context: undefined, tools: false },
      { id: 'b', name: 'b', context: undefined, tools: undefined },
      { id: 'z', name: 'Named model', context: 1000, tools: true },
    ]);
    expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', { headers: {}, signal: expect.any(AbortSignal) });
  });

  it('lists Anthropic models with native authentication and display names', async () => {
    const fetcher = json({ data: [{ id: 'claude-one', display_name: 'Claude One' }, { id: 'claude-two' }] });
    expect(await providers.listModels(settings({ providerKeys: { anthropic: 'fixture' } }), 'anthropic', fetcher)).toEqual([
      { id: 'claude-one', name: 'Claude One', tools: true }, { id: 'claude-two', name: 'claude-two', tools: true },
    ]);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ 'x-api-key': 'fixture', 'anthropic-version': '2023-06-01' });
  });

  it('filters OpenAI catalogs to chat models and marks tool support', async () => {
    const fetcher = json({ data: [{ id: 'gpt-one' }, { id: 'o3' }, { id: 'chatgpt-latest' }, { id: 'tts-one' }] });
    expect(await providers.listModels(settings({ providerKeys: { openai: 'fixture' } }), 'openai', fetcher)).toEqual([
      { id: 'chatgpt-latest', name: 'chatgpt-latest', tools: true }, { id: 'gpt-one', name: 'gpt-one', tools: true },
      { id: 'o3', name: 'o3', tools: true },
    ]);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ authorization: 'Bearer fixture' });
  });

  it('supports a local compatible provider with no key and strips trailing slashes', async () => {
    const fetcher = json({ data: [{ id: 'local' }] });
    expect(await providers.listModels(settings({ baseUrl: 'http://localhost:1234/v1///' }), '', fetcher))
      .toEqual([{ id: 'local', name: 'local' }]);
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:1234/v1/models');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({});
  });

  it('reuses a valid catalog and refreshes it after ten minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const fetcher = json({ data: [] });
    expect(await providers.listModels(settings(), undefined, fetcher)).toEqual([]);
    expect(await providers.listModels(settings(), null, fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600_000);
    await providers.listModels(settings(), '', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['openai', 'anthropic'] as const)('rejects a missing %s key before fetching', async provider => {
    const fetcher = json({ data: [] });
    await expect(providers.listModels(settings(), provider, fetcher)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider and a missing custom URL before fetching', async () => {
    const fetcher = json({ data: [] });
    await expect(providers.listModels(settings(), 'unknown', fetcher)).rejects.toMatchObject({ status: 400 });
    await expect(providers.listModels(settings({ baseUrl: undefined }), 'custom', fetcher)).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])('redacts an upstream status %i without exposing its body', async status => {
    const fetcher = json({ error: 'sensitive-upstream-detail' }, status);
    const result = providers.listModels(settings(), 'custom', fetcher);
    await expect(result).rejects.toMatchObject({ status: 502 });
    await expect(result).rejects.not.toThrow('sensitive-upstream-detail');
  });

  it('redacts network failures and treats missing data as an empty catalog', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('sensitive-network-detail'); });
    await expect(providers.listModels(settings(), 'custom', fetcher)).rejects.toThrow('Could not reach the model provider');
    expect(await providers.listModels(settings(), 'custom', json({ data: false }))).toEqual([]);
  });
});

describe('chat model configuration', () => {
  it.each(['openrouter', 'openai', 'anthropic'] as ModelProvider[])('uses %s credentials and its configured endpoint', provider => {
    const config = providers.chatModelConfig(settings({ provider, providerKeys: { [provider]: 'fixture' } }));
    expect(config).toMatchObject({ provider, model: 'fixture', apiKey: 'fixture' });
    expect(config.baseURL).toContain(provider === 'openrouter' ? 'openrouter.ai' : provider === 'anthropic' ? 'anthropic.com' : 'openai.com');
  });

  it('supplies a placeholder key for unauthenticated compatible providers', () => {
    expect(providers.chatModelConfig(settings())).toMatchObject({ apiKey: 'not-needed', baseURL: 'http://localhost:1234/v1', headers: {} });
  });

  it('uses OpenRouter referer metadata and the legacy provider default', () => {
    vi.stubEnv('PUBLIC_URL', 'https://canvas.example');
    expect(providers.chatModelConfig(settings({ provider: undefined, apiKey: 'fixture' })).headers)
      .toEqual({ 'HTTP-Referer': 'https://canvas.example', 'X-Title': 'SymbiKnow' });
    vi.stubEnv('PUBLIC_URL', '');
    expect(providers.chatModelConfig(settings({ provider: 'openrouter', apiKey: 'fixture' })).headers['HTTP-Referer']).toBe('http://localhost:5173');
  });

  it('requires a URL, a hosted key and a selected model', () => {
    expect(() => providers.chatModelConfig(settings({ baseUrl: undefined }))).toThrow('Set a base URL');
    expect(() => providers.chatModelConfig(settings({ provider: 'openai' }))).toThrow('Set a OpenAI API key');
    expect(() => providers.chatModelConfig(settings({ model: '' }))).toThrow('Choose a OpenAI-compatible model');
  });
});
