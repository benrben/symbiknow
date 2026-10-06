// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatSettings } from '../shared/types';
import { SettingsPage } from './SettingsPage';

const base: ChatSettings = { provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: '', hasApiKey: true,
  providerKeys: { openrouter: true }, secretNames: ['GITHUB_TOKEN'], mcpServers: [], mcpTokens: [] };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (path === '/api/mcp/info') return Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 0 });
    if (path === '/api/mcp/activity') return Response.json({ entries: [] });
    if (path === '/api/workspaces') return Response.json([{ id: 'team', name: 'Team', canvases: [{ id: 'planning', name: 'Planning' }, { id: 'research', name: 'Research' }] }]);
    if (path === '/api/mcp/tokens' && init?.method === 'POST') return Response.json({ token: 'atm_secretvalue', settings: { ...base,
      mcpTokens: [{ id: 'k1', name: 'Laptop', preview: '…alue', access: body?.access ?? 'read', allowedCanvasIds: body?.allowedCanvasIds,
        tools: body?.tools, createdAt: '2026-09-26T00:00:00.000Z' }] } }, { status: 201 });
    if (path.startsWith('/api/models')) return Response.json([{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', tools: true, context: 200000 }, { id: 'vendor/tiny', name: 'Tiny' }]);
    if (path === '/api/mcp/servers/test') return Response.json({ ok: true, tools: [{ name: 'search_issues', capabilities: ['search', 'read'] }, { name: 'create_issue', description: 'Create an issue' }] });
    return Response.json({ error: 'unexpected ' + path }, { status: 500 });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('settings page', () => {
  it('tracks a section exactly at the activation line when an earlier section is absent', () => {
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    const scroller = document.querySelector<HTMLElement>('.settings-page__scroll')!;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 800, 600));
    document.getElementById('settings-models')!.remove();
    vi.spyOn(document.getElementById('settings-agents')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 400, 800, 400));
    vi.spyOn(document.getElementById('settings-secrets')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 401, 800, 400));
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Agents & secrets' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Secrets' }).getAttribute('aria-current')).toBeNull();
  });
  it('tracks the section at the scroll position and keeps clicked navigation active', () => {
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    const scroller = document.querySelector<HTMLElement>('.settings-page__scroll')!;
    const positions: Record<string, number> = { models: -1600, agents: -1300, secrets: -900, servers: -400, connect: 380, plugins: 1100, activity: 1600 };
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 800, 600));
    for (const [id, top] of Object.entries(positions)) {
      const section = document.getElementById(`settings-${id}`)!;
      vi.spyOn(section, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 800, 400));
    }

    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Workspace access' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'External tools' }).getAttribute('aria-current')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true');
    fireEvent(scroller, new Event('scrollend'));
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Workspace access' }).getAttribute('aria-current')).toBe('true');
  });

  it('marks the last section at the bottom of the scroll and resumes tracking after a jump settles on its own', () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const view = render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    const scroller = document.querySelector<HTMLElement>('.settings-page__scroll')!;
    Object.defineProperties(scroller, { scrollTop: { value: 900, configurable: true }, scrollHeight: { value: 1500, configurable: true },
      clientHeight: { value: 600, configurable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true');
    act(() => { vi.advanceTimersByTime(900); });
    fireEvent.scroll(scroller);
    expect(document.querySelector('[aria-current="true"]')?.textContent).toBe('Symbi Reflex');
    view.unmount();
  });

  it('keeps client instructions hidden until chosen and creates a token shown once', async () => {
    const onSettings = vi.fn();
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={onSettings}/>);
    await waitFor(() => expect(screen.getAllByText(/https:\/\/canvas\.example\.com\/mcp/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/"type": "http"/)).toBeNull();
    expect(screen.getByText('Agents that can access this workspace')).toBeTruthy();
    expect(screen.getByText('External tools Symbi can use')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'MCP client' }), { target: { value: 'codex' } });
    expect(screen.getByText(/bearer_token_env_var = "SYMBIKNOW_MCP_TOKEN"/)).toBeTruthy();
    expect(screen.getByText(/"command": "npm"/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('atm_secretvalue')).toBeTruthy();
    expect(screen.queryByText('https://canvas.example.com/mcp/t/atm_secretvalue')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('\"access\":\"read\"');
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ mcpTokens: [expect.objectContaining({ name: 'Laptop' })] }));
  });

  it('creates a token limited to selected canvases and tools supported by its access level', async () => {
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Scoped agent' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Token access' }), { target: { value: 'propose' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas scope' }), { target: { value: 'selected' } });
    expect(await screen.findByRole('checkbox', { name: 'Team · Planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team · Planning' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool scope' }), { target: { value: 'selected' } });
    expect(screen.queryByRole('checkbox', { name: 'create_doc' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'read_doc' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'search_docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByText('atm_secretvalue');
    const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/mcp/tokens' && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Scoped agent', access: 'propose', allowedCanvasIds: ['planning'], tools: ['read_doc', 'search_docs'] });
  });

  it('shows a stored token’s effective canvas and tool limits', async () => {
    const settings = { ...base, mcpTokens: [{ id: 'k1', name: 'Reader', access: 'read' as const,
      allowedCanvasIds: ['planning'], tools: ['read_doc'], preview: '…1234', createdAt: '2026-09-26T00:00:00.000Z' }] };
    render(<SettingsPage settings={settings} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    expect(await screen.findByText('Canvases: Planning · Tools: read_doc')).toBeTruthy();
  });


  it('moves provider radio selection with arrow keys and keeps bearer tokens out of shared config', async () => {
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    const openai = screen.getAllByRole('radio')[1];
    openai.focus();
    fireEvent.keyDown(openai, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /Anthropic/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByRole('combobox', { name: 'MCP client' }), { target: { value: 'generic' } });
    expect(screen.getAllByText(/SYMBIKNOW_MCP_TOKEN/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Bearer atm_secretvalue/)).toBeNull();
  });



  it('shows recent reads, failures, affected files, revisions, scope, connection health, and the partial-audit caveat', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/workspaces') return Response.json([{ id: 'team', name: 'Team', canvases: [{ id: 'planning', name: 'Planning' }] }]);
      if (path === '/api/mcp/info') return Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 2 });
      if (path === '/api/mcp/activity') return Response.json({ entries: [
        { id: 'a1', tokenId: 'k1', tokenName: 'Laptop', access: 'read', allowedCanvasIds: ['planning'], tools: ['read_doc'], tool: 'read_document', startedAt: '2026-09-28T10:00:00.000Z', endedAt: '2026-09-28T10:00:01.000Z', outcome: 'success', canvasIds: ['planning'], documentIds: ['launch-plan'], revision: 'abc123def456' },
        { id: 'a2', tokenId: 'k1', tokenName: 'Laptop', access: 'write', tool: 'update_document', startedAt: '2026-09-28T09:58:00.000Z', endedAt: '2026-09-28T09:58:01.000Z', outcome: 'error', error: 'Conflict detected', canvasIds: ['planning'], documentIds: ['launch-plan'] },
      ] });
      return Response.json({});
    });
    const onOpenHistory = vi.fn();
    const recentTokenSettings = { ...base, mcpTokens: [{ id: 'k1', name: 'Laptop', access: 'read' as const, allowedCanvasIds: ['planning'], tools: ['read_doc'],
      preview: '…alue', createdAt: '2026-09-26T00:00:00.000Z', lastUsedAt: '2026-09-28T10:00:00.000Z' }] };
    render(<SettingsPage settings={recentTokenSettings} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()} onOpenHistory={onOpenHistory}/>);
    expect(await screen.findByText('read_document')).toBeTruthy();
    expect(screen.getByText('update_document')).toBeTruthy();
    expect(screen.getByText('Conflict detected')).toBeTruthy();
    expect(screen.getAllByText('planning').length).toBeGreaterThan(0);
    expect(screen.getAllByText('launch-plan').length).toBeGreaterThan(0);
    expect(screen.getByText(/abc123def456/)).toBeTruthy();
    expect(screen.getByText(/2 active sessions reported/)).toBeTruthy();
    expect(screen.getByText(/not a complete audit log/)).toBeTruthy();
    expect(screen.getByText(/most recent observed use/)).toBeTruthy();
    expect(screen.getAllByText(/read access/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Canvases: Planning · Tools: read_doc/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect in document History' }));
    expect(onOpenHistory).toHaveBeenCalledWith('planning', 'launch-plan', 'abc123def456');
  });

  it('shows an empty state and retries activity after a load failure', async () => {
    let activityCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/mcp/activity') {
        activityCalls++;
        return activityCalls === 1 ? Response.json({ error: 'Activity temporarily unavailable' }, { status: 503 }) : Response.json({ entries: [] });
      }
      if (path === '/api/mcp/info') return Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: false, activeSessions: 0 });
      return Response.json({});
    });
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Activity temporarily unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No recent tool calls are recorded/)).toBeTruthy();
    expect(activityCalls).toBe(2);
  });

  it('recovers connection health checks and exposes token creation failures', async () => {
    let infoCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/mcp/info') {
        infoCalls++;
        return infoCalls === 1
          ? Response.json({ error: 'Connection check failed' }, { status: 503 })
          : Response.json({ origin: 'https://canvas.example.com', endpoint: 'https://canvas.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 1 });
      }
      if (path === '/api/mcp/tokens' && init?.method === 'POST') return Response.json({ error: 'Token service unavailable' }, { status: 503 });
      if (path === '/api/mcp/activity') return Response.json({ entries: [] });
      if (path === '/api/workspaces') return Response.json([]);
      return Response.json({});
    });
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);

    expect(await screen.findByText('Unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection check' }));
    expect(await screen.findByText('Status available')).toBeTruthy();
    expect(infoCalls).toBe(2);

    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Token service unavailable');
    expect(screen.queryByText('Copy this token now. It is shown once and never included in shared setup instructions.')).toBeNull();
  });

  it('confirms immediate token revocation and leaves access unchanged when canceled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const settingsWithToken = { ...base, mcpTokens: [{ id: 'k1', name: 'Laptop', preview: '…alue', createdAt: '2026-09-26T00:00:00.000Z' }] };
    render(<SettingsPage settings={settingsWithToken} busy={false} onSave={vi.fn()} onCancel={vi.fn()} onSettings={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('takes effect immediately'));
    expect(fetch).not.toHaveBeenCalledWith('/api/mcp/tokens/k1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('shows a visible error when saving pending Settings fails', async () => {
    render(<SettingsPage settings={base} busy={false} onSave={vi.fn().mockRejectedValue(new Error('Settings server is unavailable'))}
      onCancel={vi.fn()} onSettings={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Settings server is unavailable');
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
    fireEvent.click(within(screen.getByRole('region', { name: 'External tools Symbi can use' })).getAllByRole('button', { name: 'Test' }).at(-1)!);
    expect(await screen.findByText('Connected · 2 tools')).toBeTruthy();
    expect(screen.getByText('search_issues · search, read')).toBeTruthy();
    expect(screen.getByText('create_issue · Create an issue')).toBeTruthy();
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
});
