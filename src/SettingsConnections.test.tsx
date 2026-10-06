// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSettings } from '../shared/types';
import { ConnectAgents } from './SettingsConnections';

const settings: ChatSettings = { provider: 'openrouter', model: 'fixture', systemPrompt: '', hasApiKey: false, mcpTokens: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(override?: (route: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = override?.(url, init);
    if (response) return response;
    if (url === '/api/mcp/info') return Response.json({ origin: 'https://team.example.com', endpoint: 'https://team.example.com/mcp', publicUrlConfigured: true, accessProtected: true, activeSessions: 0 });
    if (url === '/api/workspaces') return Response.json([{ id: 'team', name: 'Team', canvases: [{ id: 'planning', name: 'Planning' }] }]);
    if (url === '/api/mcp/activity') return Response.json({ entries: [] });
    if (url === '/api/mcp/tokens' && init?.method === 'POST') return Response.json({ token: 'atm_private', settings });
    return Response.json(settings);
  }));
}
beforeEach(() => { fixture(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace agent connections', () => {
  it.each(['Canvas scope', 'Tool scope'])('does not create an empty selected %s token through the Enter shortcut', async scope => {
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Agent' } });
    fireEvent.change(screen.getByLabelText(scope), { target: { value: 'selected' } });
    expect((screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'Enter' });
    await act(async () => {});
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === '/api/mcp/tokens' && init?.method === 'POST')).toHaveLength(0);
  });

  it('prevents duplicate token requests while a creation is pending and allows another afterward', async () => {
    const pending = deferred<Response>();
    let creations = 0;
    fixture((url, init) => { if (url === '/api/mcp/tokens' && init?.method === 'POST') { creations++; return creations === 1 ? pending.promise : Response.json({ token: 'atm_second', settings }); } });
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect((screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'Enter' });
    expect(creations).toBe(1);
    await act(async () => { pending.resolve(Response.json({ token: 'atm_first', settings })); });
    await screen.findByText('atm_first');
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Next agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('atm_second')).toBeTruthy();
    expect(creations).toBe(2);
  });

  it('shows a recoverable error when clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not copy. Select and copy the text manually.');
    writeText.mockResolvedValue(undefined);
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('explains unavailable clipboard support and resets a successful copy receipt', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not copy');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await screen.findByRole('button', { name: 'Copied' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull(), { timeout: 2000 });
  });

  it('shows both Claude setup variants and keeps the raw token confined to private connector instructions', async () => {
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    fireEvent.change(screen.getByLabelText('MCP client'), { target: { value: 'claude-code' } });
    expect(screen.getByText(/claude mcp add --transport http/)).toBeTruthy();
    expect(screen.getByText(/"type": "http"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('MCP client'), { target: { value: 'connector' } });
    expect(screen.getByText('Create a token above first. Its raw value is shown once.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Private agent' } });
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'Enter' });
    expect(await screen.findByText('https://team.example.com/mcp/t/atm_private')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('MCP client'), { target: { value: 'generic' } });
    expect(screen.getByText(/"Authorization": "Bearer \$\{SYMBIKNOW_MCP_TOKEN\}"/)).toBeTruthy();
    expect(screen.queryByText('https://team.example.com/mcp/t/atm_private')).toBeNull();
  });

  it('keeps blank names inert for Enter and ignores unrelated keys', async () => {
    render(<ConnectAgents settings={{ ...settings, mcpTokens: undefined }} onSettings={vi.fn()}/>);
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'x' });
    await act(async () => {});
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/mcp/tokens')).toHaveLength(0);
    expect(screen.getByText('0 active')).toBeTruthy();
  });

  it('deselects canvases and tools and filters write tools when reducing access', async () => {
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Canvas scope'), { target: { value: 'selected' } });
    const canvas = await screen.findByRole('checkbox', { name: 'Team · Planning' });
    fireEvent.click(canvas); fireEvent.click(canvas);
    expect((canvas as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Token access'), { target: { value: 'write' } });
    expect(screen.getByText('Can read and make workspace changes.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tool scope'), { target: { value: 'selected' } });
    const read = screen.getByRole('checkbox', { name: 'read_doc' });
    fireEvent.click(read); fireEvent.click(read); fireEvent.click(read);
    fireEvent.click(screen.getByRole('checkbox', { name: 'edit_doc' }));
    fireEvent.change(screen.getByLabelText('Token access'), { target: { value: 'read' } });
    expect(screen.queryByRole('checkbox', { name: 'edit_doc' })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'read_doc' }) as HTMLInputElement).checked).toBe(true);
  });

  it('caps selected canvases at 100 and allows replacing one selection', async () => {
    fixture(url => url === '/api/workspaces' ? Response.json([{ id: 'team', name: 'Team', canvases: Array.from({ length: 101 }, (_, index) => ({ id: `canvas-${index}`, name: `Canvas ${index}` })) }]) : undefined);
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Canvas scope'), { target: { value: 'selected' } });
    await screen.findByRole('checkbox', { name: 'Team · Canvas 100' });
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    for (const box of boxes.slice(0, 100)) fireEvent.click(box);
    expect(boxes[100].disabled).toBe(true);
    expect(boxes[0].disabled).toBe(false);
    expect(screen.getByText('Tokens can be limited to at most 100 canvases.')).toBeTruthy();
    fireEvent.click(boxes[0]); fireEvent.click(boxes[100]);
    expect(boxes.filter(box => box.checked)).toHaveLength(100);
  });

  it('shows loading and empty canvas scopes without authorizing a token', async () => {
    const pending = deferred<Response>();
    fixture(url => url === '/api/workspaces' ? pending.promise : undefined);
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Canvas scope'), { target: { value: 'selected' } });
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Agent' } });
    expect(screen.getByText('Loading canvases…')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Token name'), { key: 'Enter' });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/mcp/tokens')).toHaveLength(0);
    await act(async () => pending.resolve(Response.json([])));
    expect(screen.getByText('No canvases are available.')).toBeTruthy();
  });

  it('retries unavailable canvas lists and displays unknown saved canvas identifiers safely', async () => {
    let attempts = 0;
    fixture(url => url === '/api/workspaces' && ++attempts === 1 ? Response.json({ error: 'Canvas list unavailable' }, { status: 503 }) : undefined);
    render(<ConnectAgents settings={{ ...settings, mcpTokens: [{ id: 'legacy', name: 'Legacy', preview: '…old', allowedCanvasIds: ['missing'], createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-01T01:00:00Z' }] }} onSettings={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Canvas scope'), { target: { value: 'selected' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas list unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox', { name: 'Team · Planning' })).toBeTruthy();
    expect(screen.getByText('Canvases: missing · All write tools')).toBeTruthy();
    expect(screen.getByText(/last used/)).toBeTruthy();
  });

  it.each([false, true])('revokes a token and recovers errors with non-Error callback failure=%s', unexpected => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSettings = vi.fn(() => { if (unexpected) throw 'Unexpected callback failure'; });
    fixture((url, init) => url === '/api/mcp/tokens/legacy' && init?.method === 'DELETE' && !unexpected ? Response.json({ error: 'Cannot revoke now' }, { status: 503 }) : undefined);
    render(<ConnectAgents settings={{ ...settings, mcpTokens: [{ id: 'legacy', name: 'Legacy', preview: '…old', createdAt: '2026-10-01T00:00:00Z' }] }} onSettings={onSettings}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    return screen.findByRole('alert').then(alert => { expect(alert.textContent).toContain(unexpected ? 'Could not revoke the token.' : 'Cannot revoke now'); });
  });

  it('updates settings after successful token revocation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSettings = vi.fn();
    render(<ConnectAgents settings={{ ...settings, mcpTokens: [{ id: 'legacy', name: 'Legacy', preview: '…old', createdAt: '2026-10-01T00:00:00Z' }] }} onSettings={onSettings}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith(settings));
  });

  it('provides an actionable token creation error when an external settings callback throws a primitive', async () => {
    render(<ConnectAgents settings={settings} onSettings={() => { throw 'Host callback failed'; }}/>);
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not create a token.');
  });

  it.each([null, {}])('rejects incomplete activity payload %j and recovers using Refresh activity', async payload => {
    let attempts = 0;
    fixture(url => url === '/api/mcp/activity' && ++attempts === 1 ? Response.json(payload) : undefined);
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Activity response was incomplete. Retry in a moment.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    expect(await screen.findByText(/No recent tool calls are recorded/)).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it.each(['info', 'workspaces', 'activity'])('surfaces an unexpected non-Error %s response parser failure and retries', async target => {
    let failed = false;
    fixture(url => {
      const wanted = { info: '/api/mcp/info', workspaces: '/api/workspaces', activity: '/api/mcp/activity' }[target];
      if (url !== wanted || failed) return;
      failed = true;
      const response = Response.json({});
      response.json = () => Promise.reject('Unexpected body parser failure');
      return response;
    });
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    if (target === 'workspaces') fireEvent.change(screen.getByLabelText('Canvas scope'), { target: { value: 'selected' } });
    const messages: Record<string, string> = { info: 'Connection health is unavailable.', workspaces: 'Could not load canvases.', activity: 'Could not load agent activity.' };
    expect((await screen.findByRole('alert')).textContent).toContain(messages[target]);
    fireEvent.click(screen.getByRole('button', { name: target === 'info' ? 'Retry connection check' : 'Retry' }));
    if (target === 'workspaces') expect(await screen.findByRole('checkbox', { name: 'Team · Planning' })).toBeTruthy();
    else if (target === 'info') expect(await screen.findByText('Status available')).toBeTruthy();
    else expect(await screen.findByText(/No recent tool calls are recorded/)).toBeTruthy();
  });

  it.each([false, true])('discards an activity request after unmount, failure=%s', async failed => {
    const pending = deferred<Response>();
    fixture(url => url === '/api/mcp/activity' ? pending.promise : undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    unmount();
    await act(async () => pending.resolve(failed ? Response.json({ error: 'Late activity failure' }, { status: 503 }) : Response.json({ entries: [] })));
    expect(screen.queryByText(/No recent tool calls are recorded/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders historical activity without dates or affected identifiers and opens only complete history references', async () => {
    const entry = { id: 'first', tokenId: 'agent', tokenName: 'Reader', access: 'read', tool: 'read_doc', startedAt: '2026-10-01T00:00:00Z', endedAt: '', outcome: 'success', canvasIds: [], documentIds: [], revision: 'revision-first' };
    fixture(url => url === '/api/mcp/activity' ? Response.json({ entries: [entry,
      { ...entry, id: 'second', canvasIds: ['planning'], revision: 'revision-second' },
      { ...entry, id: 'third', canvasIds: undefined, documentIds: undefined, revision: undefined },
    ] }) : undefined);
    const onOpenHistory = vi.fn();
    render(<ConnectAgents settings={settings} onSettings={vi.fn()} onOpenHistory={onOpenHistory}/>);
    await screen.findByText('revision-second');
    expect(screen.getAllByText('read_doc')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Inspect in document History' })).toBeNull();
    expect(onOpenHistory).not.toHaveBeenCalled();
  });

  it('shows a revision even when its host does not provide document history navigation', async () => {
    fixture(url => url === '/api/mcp/activity' ? Response.json({ entries: [{ id: 'first', tokenId: 'agent', tokenName: 'Reader', access: 'read', tool: 'read_doc', startedAt: '2026-10-01T00:00:00Z', endedAt: '', outcome: 'success', canvasIds: ['planning'], documentIds: ['evidence'], revision: 'revision-first' }] }) : undefined);
    render(<ConnectAgents settings={settings} onSettings={vi.fn()}/>);
    expect(await screen.findByText('revision-first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect in document History' })).toBeNull();
  });

  it('preserves scoped token descriptions when a legacy workspace response lacks canvas metadata', async () => {
    fixture(url => url === '/api/workspaces' ? Response.json([{ id: 'legacy', name: 'Legacy' }]) : undefined);
    render(<ConnectAgents settings={{ ...settings, mcpTokens: [{ id: 'legacy', name: 'Legacy agent', preview: '…old', access: 'read', allowedCanvasIds: ['missing'], createdAt: '2026-10-01T00:00:00Z' }] }} onSettings={vi.fn()}/>);
    await screen.findByText('Status available');
    expect(screen.getByText('Canvases: missing · All read tools')).toBeTruthy();
  });
});
