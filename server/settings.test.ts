import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeProvider, defaultPrivateSettings, mcpToolNames, newMcpToken, providerKey,
  providerReady, publicSettings, resolvedHeaders, updatedSettings, type PrivateSettings,
} from './settings.js';
import type { ExternalMcpServer } from '../shared/types.js';

afterEach(() => vi.unstubAllEnvs());
const settings = (patch: Partial<PrivateSettings> = {}): PrivateSettings => ({ ...defaultPrivateSettings, ...patch });
const update = (input: Record<string, unknown>, previous = settings()) => updatedSettings(previous, input);

describe('private and public settings', () => {
  it('hides retired Jev configuration and ignores updates to it while retaining legacy private data', () => {
    const legacy = { ...settings(), jevApiKey: 'legacy-private-key', reviewers: 'Legacy reviewer', workAreas: 'Legacy area',
      tagVocabulary: 'legacy tag', jevPolicy: { label: { show: 0.4, apply: 0.7 } } };
    const visible = publicSettings(legacy);
    for (const field of ['hasJevApiKey', 'reviewers', 'workAreas', 'tagVocabulary', 'jevPolicy']) expect(visible).not.toHaveProperty(field);
    const saved = updatedSettings(legacy, { model: 'retained-model', jevApiKey: 'replacement', reviewers: 'replacement' });
    expect(saved).toMatchObject({ model: 'retained-model', jevApiKey: 'legacy-private-key', reviewers: 'Legacy reviewer' });
    expect(publicSettings(saved)).toMatchObject({ model: 'retained-model' });
    expect(JSON.stringify(publicSettings(saved))).not.toContain('legacy-private-key');
    expect(updatedSettings(settings(), { jevApiKey: 'new-private-key', jevPolicy: {} })).not.toHaveProperty('jevApiKey');
  });

  it('uses the legacy default for absent and unsupported stored providers', () => {
    expect(activeProvider(settings({ provider: undefined }))).toBe('openrouter');
    expect(activeProvider(settings({ provider: 'old-provider' as PrivateSettings['provider'] }))).toBe('openrouter');
    expect(activeProvider(settings({ provider: 'custom' }))).toBe('custom');
  });

  it('prefers saved keys then legacy keys then environment values', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'environment');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(providerKey(settings({ apiKey: 'legacy', providerKeys: { openrouter: 'saved' } }))).toBe('saved');
    expect(providerKey(settings({ apiKey: 'legacy' }))).toBe('legacy');
    expect(providerKey(settings())).toBe('environment');
    expect(providerKey(settings(), 'openai')).toBe('');
    expect(providerReady(settings({ provider: 'custom', baseUrl: 'http://localhost:9000' }))).toBe(true);
    expect(providerReady(settings({ provider: 'custom' }))).toBe(false);
  });

  it('exposes configuration and token metadata without private material', () => {
    const first = newMcpToken('First', 'write', { allowedCanvasIds: ['canvas-one'], tools: ['read_doc'] }).stored;
    const second = newMcpToken('Second').stored;
    const result = publicSettings(settings({ apiKey: 'private-key', secrets: { Z_LAST: 'private-secret', A_FIRST: 'first' },
      baseUrl: 'http://localhost:9000', agentProfile: 'research', agentPlugins: [],
      mcpTokens: [{ ...first, lastUsedAt: '2026-10-01T00:00:00Z' }, { ...second, access: undefined }] }));
    expect(result.secretNames).toEqual(['A_FIRST', 'Z_LAST']);
    expect(result).toMatchObject({ baseUrl: 'http://localhost:9000', agentProfile: 'research', agentPlugins: [] });
    expect(result.mcpTokens?.[0]).toMatchObject({ tools: ['read_doc'], allowedCanvasIds: ['canvas-one'], lastUsedAt: '2026-10-01T00:00:00Z' });
    expect(result.mcpTokens?.[1].access).toBe('write');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(JSON.stringify(result)).not.toContain(first.hash);
    expect(publicSettings(settings())).toMatchObject({ groupBy: 'work_area', mcpServers: [], customProfiles: [] });
  });

  it('keeps unspecified fields and migrates legacy credentials when switching providers', () => {
    const previous = settings({ apiKey: 'legacy', model: 'existing', baseUrl: 'https://local.example/v1',
      secrets: { TOKEN: 'value' }, agentPlugins: [] });
    expect(update({}, previous)).toMatchObject({ model: 'existing', providerKeys: { openrouter: 'legacy' }, agentPlugins: [], secrets: { TOKEN: 'value' } });
    expect(update({ provider: 'openai', apiKey: ' next ', baseUrl: '' }, previous))
      .toMatchObject({ provider: 'openai', apiKey: 'legacy', providerKeys: { openrouter: 'legacy', openai: 'next' } });
    expect(update({ baseUrl: '' }, previous).baseUrl).toBeUndefined();
    expect(update({ providerKeys: { openrouter: ' new ' } }, previous).apiKey).toBe('new');
  });

  it.each([
    ['provider', 'missing'], ['model', ''], ['model', 5], ['model', 'x'.repeat(121)],
    ['systemPrompt', 'x'.repeat(20_001)], ['baseUrl', 'not a URL'], ['baseUrl', 'ftp://host'],
    ['apiKey', 2], ['apiKey', 'x'.repeat(4097)], ['providerKeys', null], ['providerKeys', false],
    ['providerKeys', { missing: 'key' }], ['providerKeys', { openai: 2 }], ['groupBy', 'missing'],
    ['agentPlugins', null], ['agentPlugins', ['missing']], ['agentProfile', 2], ['agentProfile', 'missing'],
  ])('rejects invalid %s values before saving', (field, value) => {
    expect(() => update({ [field]: value })).toThrow();
  });

  it('updates editable text, grouping, plugins, and agent profiles', () => {
    expect(update({ model: ' model ', systemPrompt: ' prompt ', groupBy: 'purpose', agentPlugins: ['tasks', 'tasks'],
      agentProfile: 'planner' })).toMatchObject({ model: 'model', systemPrompt: 'prompt', groupBy: 'purpose', agentPlugins: ['tasks'], agentProfile: 'planner' });
  });
});

describe('agent profiles and secrets', () => {
  it('assigns distinct IDs, retains requested IDs, and supports names without Latin characters', () => {
    const next = update({ customProfiles: [
      { name: 'Writer', instructions: ' Write ' }, { name: 'Writer', instructions: 'Other' },
      { id: 'custom-saved', name: 'Saved', instructions: 'Saved' }, { name: '日本語', instructions: 'Help' },
    ], agentProfile: 'custom-saved' });
    expect(next.customProfiles?.slice(0, 3).map(profile => profile.id)).toEqual(['custom-writer', 'custom-writer-2', 'custom-saved']);
    expect(next.customProfiles?.[0].instructions).toBe('Write');
    expect(next.customProfiles?.[3].id).toMatch(/^custom-[a-f0-9-]{8}$/);
    expect(next.agentProfile).toBe('custom-saved');
    expect(update({ customProfiles: [] }, next).agentProfile).toBeUndefined();
  });

  it.each([null, {}, Array.from({ length: 21 }, () => ({ name: 'x', instructions: 'x' })), [null], [{ name: 'x', instructions: '' }]])
    ('rejects malformed profiles', value => expect(() => update({ customProfiles: value })).toThrow());

  it('merges, trims and removes secrets and removes servers whose bearer secret was deleted', () => {
    const previous = update({ secrets: { TOKEN: ' old ', KEEP: 'keep' },
      mcpServers: [{ name: 'Service', url: 'https://mcp.example', bearerSecret: 'TOKEN' }] });
    expect(update({ secrets: { TOKEN: null, NEW: ' new ' } }, previous)).toMatchObject({ secrets: { KEEP: 'keep', NEW: 'new' }, mcpServers: [] });
  });

  it.each([null, [], false, { lowercase: 'x' }, { TOKEN: '' }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`S${i}`, 'x']))])
    ('rejects invalid secret collections', value => expect(() => update({ secrets: value })).toThrow());
});

describe('outside MCP configuration', () => {
  const server: ExternalMcpServer = { id: 'service', name: 'Service', url: 'https://mcp.example', enabled: true };
  it('normalizes server identity, URLs, headers, authentication and enablement', () => {
    const next = update({ secrets: { TOKEN: 'saved' }, mcpServers: [
      { id: 'saved-id', name: ' Service ', url: 'https://mcp.example///', bearerSecret: 'TOKEN', headers: { 'X-Name': ' value ' } },
      { name: 'Service', url: 'http://localhost:9000', bearerSecret: '', enabled: false },
      { name: 'Service', url: 'https://other.example' },
    ] });
    expect(next.mcpServers?.map(item => item.id)).toEqual(['saved-id', 'service', 'service-2']);
    expect(next.mcpServers?.[0]).toMatchObject({ name: 'Service', url: 'https://mcp.example', headers: { 'X-Name': 'value' }, bearerSecret: 'TOKEN' });
    expect(next.mcpServers?.[1]).toMatchObject({ enabled: false, headers: {} });
  });

  it.each([null, {}, Array.from({ length: 21 }, () => server), [null],
    [{ ...server, bearerSecret: 'MISSING' }], [{ ...server, headers: null }], [{ ...server, headers: [] }],
    [{ ...server, headers: { 'bad name': 'value' } }], [{ ...server, headers: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`X-${i}`, 'x'])) }]])
    ('rejects invalid server configuration', value => expect(() => update({ mcpServers: value })).toThrow());

  it('resolves explicit placeholders and bearer secrets without changing ordinary headers', () => {
    expect(resolvedHeaders({ ...server, headers: { Authorization: 'value-${secret:TOKEN}', 'X-Plain': 'plain' }, bearerSecret: 'TOKEN' }, { TOKEN: 'saved' }))
      .toEqual({ Authorization: 'Bearer saved', 'X-Plain': 'plain' });
    expect(resolvedHeaders(server, {})).toEqual({});
    expect(resolvedHeaders({ ...server, bearerSecret: 'MISSING' }, {})).toEqual({ Authorization: 'Bearer ' });
    expect(() => resolvedHeaders({ ...server, headers: { Authorization: '${secret:MISSING}' } }, {})).toThrow('Secret MISSING is not saved');
  });
});

describe('scoped MCP tokens', () => {
  it('creates hashed tokens with default read access and explicit read/propose/write scopes', () => {
    const result = newMcpToken(' Name ');
    expect(result.token).toMatch(/^atm_[A-Za-z0-9_-]{32}$/);
    expect(result.stored).toMatchObject({ name: 'Name', access: 'read', preview: `…${result.token.slice(-4)}` });
    expect(result.stored.hash).not.toContain(result.token);
    expect(newMcpToken('Scoped', 'propose', { allowedCanvasIds: ['canvas-one'], tools: ['list_tasks', 'read_doc'] }).stored)
      .toMatchObject({ allowedCanvasIds: ['canvas-one'], tools: ['list_tasks', 'read_doc'] });
    expect(newMcpToken('Writer', 'write', { tools: ['edit_doc'] }).stored.tools).toEqual(['edit_doc']);
  });

  it.each([[], 'canvas', [2], ['bad/id'], ['same', 'same'], Array.from({ length: 101 }, (_, i) => `c-${i}`)])
    ('rejects invalid canvas scopes', value => expect(() => newMcpToken('Token', 'read', { allowedCanvasIds: value })).toThrow());
  it.each([[], 'read_doc', [2], ['missing'], ['read_doc', 'read_doc'], [...mcpToolNames, 'read_doc']])
    ('rejects invalid tool scopes', value => expect(() => newMcpToken('Token', 'write', { tools: value })).toThrow());
  it.each(['read', 'propose'])('rejects write tools for %s tokens', access => {
    expect(() => newMcpToken('Token', access, { tools: ['edit_doc'] })).toThrow('exceed this token access level');
  });
  it('rejects unknown access and removed feature tools', () => {
    expect(() => newMcpToken('Token', 'admin')).toThrow('access must be');
    expect(() => newMcpToken('Token', 'read', { tools: ['run_workspace_automation'] })).toThrow('distinct supported MCP tool names');
  });
});
