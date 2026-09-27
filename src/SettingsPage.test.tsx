// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatSettings } from '../shared/types';
import { defaultJevPolicy } from '../shared/policy';
import { SettingsPage } from './SettingsPage';

const base: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: true, hasJevApiKey: false,
  reviewers: '', workAreas: '', providerKeys: { openrouter: true }, secretNames: ['GITHUB_TOKEN'], mcpServers: [], mcpTokens: [] };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/mcp/info') return Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 0 });
    if (path === '/api/mcp/tokens' && init?.method === 'POST') return Response.json({ token: 'atm_secretvalue', settings: { ...base,
      mcpTokens: [{ id: 'k1', name: 'Laptop', preview: '…alue', createdAt: '2026-09-26T00:00:00.000Z' }] } }, { status: 201 });
    if (path.startsWith('/api/models')) return Response.json([{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', tools: true, context: 200000 }, { id: 'vendor/tiny', name: 'Tiny' }]);
    if (path === '/api/mcp/servers/test') return Response.json({ ok: true, tools: [{ name: 'search_issues' }, { name: 'create_issue' }] });
    if (path === '/api/settings/jev-feedback') return Response.json([]);
    if (path === '/api/jev/usage') return Response.json({ model: 'jev-1.13.0',
      month: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      today: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
    if (path === '/api/jev/calibration') return Response.json([]);
    return Response.json({ error: 'unexpected ' + path }, { status: 500 });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('settings page', () => {
  it('shows remote connection snippets and creates a token shown once', async () => {
    const onSettings = vi.fn();
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={onSettings}/>);
    await waitFor(() => expect(screen.getAllByText(/https:\/\/canvas\.example\.com\/mcp/).length).toBeGreaterThan(2));
    expect(screen.getByText(/"type": "http"/)).toBeTruthy();
    expect(screen.getByText(/bearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"/)).toBeTruthy();
    expect(screen.getByText(/"command": "npm"/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('atm_secretvalue')).toBeTruthy();
    expect(screen.getByText('https://canvas.example.com/mcp/t/atm_secretvalue')).toBeTruthy();
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ mcpTokens: [expect.objectContaining({ name: 'Laptop' })] }));
  });

  it('warns when the endpoint is only reachable from this computer', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ origin: 'http://127.0.0.1:8787', endpoint: 'http://127.0.0.1:8787/mcp', publicUrlConfigured: false, accessProtected: false, activeSessions: 0 }));
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    expect(await screen.findByText(/only works on this computer/)).toBeTruthy();
  });

  it('saves provider, model, profiles, secrets, and outside MCP servers in one request', async () => {
    const onSave = vi.fn<(payload: Record<string, unknown>) => Promise<void>>(async () => undefined);
    render(<SettingsPage settings={base} busy={false} onSave={onSave} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse models' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Filter models' }), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('option', { name: /Claude Sonnet 4.5/ }));
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'anthropic/claude-sonnet-4.5');

    fireEvent.change(screen.getByRole('textbox', { name: 'New profile name' }), { target: { value: 'Sales coach' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'New profile instructions' }), { target: { value: 'Focus on deals.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    fireEvent.change(screen.getByRole('combobox', { name: /Agent profile/ }), { target: { value: 'custom-sales-coach' } });

    fireEvent.change(screen.getByRole('textbox', { name: 'Secret name' }), { target: { value: 'linear_key' } });
    fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'lin_private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove secret GITHUB_TOKEN' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'MCP server name' }), { target: { value: 'Linear' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'MCP server URL' }), { target: { value: 'https://mcp.linear.app/mcp' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Authorization secret' }), { target: { value: 'LINEAR_KEY' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'MCP servers' })).getAllByRole('button', { name: 'Test' }).at(-1)!);
    expect(await screen.findByText(/Reachable · 2 tools: search_issues, create_issue/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    fireEvent.click(screen.getByRole('radio', { name: /Anthropic/ }));
    fireEvent.change(screen.getByLabelText(/^Anthropic API key/), { target: { value: 'sk-ant-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic', apiKey: 'sk-ant-key', model: 'anthropic/claude-sonnet-4.5', agentProfile: 'custom-sales-coach',
      customProfiles: [{ id: 'custom-sales-coach', name: 'Sales coach', instructions: 'Focus on deals.' }],
      secrets: { LINEAR_KEY: 'lin_private', GITHUB_TOKEN: null },
      mcpServers: [{ id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', enabled: true, bearerSecret: 'LINEAR_KEY' }],
    });
  });

  it('shows every confidence threshold and saves edits with reviewer expertise', async () => {
    const onSave = vi.fn<(payload: Record<string, unknown>) => Promise<void>>(async () => undefined);
    render(<SettingsPage settings={{ ...base, tagVocabulary: 'onboarding', jevPolicy: { link: { show: 0.7, apply: 0.8 } } }} busy={false}
      onSave={onSave} onCancel={vi.fn()} onSettings={vi.fn()}/>);

    const table = screen.getByRole('table', { name: 'Jev confidence thresholds' });
    expect(within(table).getAllByRole('row')).toHaveLength(Object.keys(defaultJevPolicy).length + 1);
    expect(screen.getByRole('spinbutton', { name: 'Connect documents show' })).toHaveProperty('value', '0.7');
    expect(screen.getByRole('spinbutton', { name: 'Connect documents apply' })).toHaveProperty('value', '0.8');
    expect(screen.getByRole('spinbutton', { name: 'Verify answers apply' })).toHaveProperty('value', '0.7');

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Connect documents show' }), { target: { value: '0.85' } });
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Show cannot exceed Apply'));

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Connect documents apply' }), { target: { value: '0.9' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Review teams' }), { target: { value: 'Dana: backend, billing, Postgres\nAri: product strategy' } });
    expect(screen.getByRole('textbox', { name: 'Review teams' })).toHaveProperty('maxLength', 2000);
    expect(screen.getByRole('textbox', { name: 'Tag vocabulary' })).toHaveProperty('value', 'onboarding');
    expect(screen.getByRole('textbox', { name: 'Tag vocabulary' })).toHaveProperty('maxLength', 2500);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag vocabulary' }), { target: { value: 'onboarding\nbilling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      reviewers: 'Dana: backend, billing, Postgres\nAri: product strategy',
      tagVocabulary: 'onboarding\nbilling',
      jevPolicy: { ...defaultJevPolicy, link: { show: 0.85, apply: 0.9 } },
    });
  });

  it('shows feedback rates and suggests a lower threshold only for well reviewed buckets', async () => {
    const baseFetch = vi.mocked(fetch);
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/settings/jev-feedback') return Response.json([{ category: 'connection', bucket: '0.75–0.85', applied: 19, dismissed: 1, applyRate: 0.95 },
        { category: 'merge', bucket: '0.75–0.85', applied: 5, dismissed: 0, applyRate: 1 }]);
      if (path === '/api/jev/calibration') return Response.json([]);
      if (path === '/api/jev/usage') return Response.json({ model: 'jev-1.13.0',
        month: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        today: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
      return Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 0 });
    });
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    const table = await screen.findByRole('table', { name: 'Jev feedback rates' });
    expect(within(table).getByText('95%')).toBeTruthy();
    expect(within(table).getByText('Consider lowering Apply to 0.75')).toBeTruthy();
    const mergeRow = within(table).getByRole('rowheader', { name: 'merge' }).closest('tr')!;
    expect(within(mergeRow).queryByText('Consider lowering Apply to 0.75')).toBeNull();
  });

  it('shows Jev usage this month and lets Use fill the draft show threshold', async () => {
    const baseFetch = vi.mocked(fetch);
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/jev/usage') return Response.json({ model: 'jev-1.13.0',
        month: { requests: 3, questions: 6, inputTokens: 1000, outputTokens: 40, estimatedCostUsd: 0.042 },
        today: { requests: 1, questions: 2, inputTokens: 500, outputTokens: 20, estimatedCostUsd: 0.021 } });
      if (path === '/api/jev/calibration') return Response.json([{ kind: 'link', suggestedShow: 0.75, sampleSize: 45 }]);
      return Response.json([]);
    });
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);

    expect(await screen.findByText(/This month: 3 requests, 1,040 tokens, \$0.0420 estimated\./)).toBeTruthy();
    expect(screen.getByText('jev-1.13.0')).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Jev confidence thresholds' });
    const linkRow = within(table).getByRole('rowheader', { name: 'Connect documents' }).closest('tr')!;
    expect(await within(linkRow).findByText(/Show ≥ 0.75 \(n=45\)/)).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Connect documents show' })).toHaveProperty('value', '0.65');
    fireEvent.click(within(linkRow).getByRole('button', { name: 'Use' }));
    expect(screen.getByRole('spinbutton', { name: 'Connect documents show' })).toHaveProperty('value', '0.75');
    expect(screen.getByRole('spinbutton', { name: 'Connect documents apply' })).toHaveProperty('value', '0.75');
  });
});
