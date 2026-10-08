// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSettings, WorkspaceSummary } from '../shared/types';
import { useConnectionTokens } from './useConnectionTokens';

const catalog: ChatSettings['mcpToolCatalog'] = [{ name: 'read_doc', access: 'read' }, { name: 'upload_file', access: 'propose' },
  { name: 'apply_file_proposal', access: 'write', canApprove: true }, { name: 'jev_configure', access: 'write', canConfigure: true }];
const settings: ChatSettings = { provider: 'openrouter', model: 'fixture', systemPrompt: '', hasApiKey: false, mcpTokens: [], mcpToolCatalog: catalog };
const workspaces = [{ id: 'team', name: 'Team', canvases: [{ id: 'planning', name: 'Planning' }] }] as unknown as WorkspaceSummary[];

function tokenServer() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect([url, init?.method]).toEqual(['/api/mcp/tokens', 'POST']);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ token: `atm_${bodies.length}`, settings });
  }));
  return bodies;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('connection token payload', () => {
  it('sends approval for a write token and drops review grants once access is lowered', async () => {
    const bodies = tokenServer();
    const onSettings = vi.fn();
    const { result } = renderHook(() => useConnectionTokens(workspaces, onSettings, catalog));
    act(() => {
      result.current.setName('  Release agent  '); result.current.setAccess('write'); result.current.setCanApprove(true);
      result.current.setCanvasScope('selected'); result.current.setSelectedCanvasIds(['planning']);
      result.current.setToolScope('selected'); result.current.setSelectedTools(['read_doc', 'apply_file_proposal', 'jev_configure']);
    });
    await act(async () => { await result.current.createToken(); });
    act(() => { result.current.setName('Reviewer'); result.current.setAccess('propose'); result.current.setCanConfigure(true); });
    await act(async () => { await result.current.createToken(); });
    expect(bodies).toEqual([
      { name: 'Release agent', access: 'write', canApprove: true, canConfigure: false, allowedCanvasIds: ['planning'], tools: ['read_doc', 'apply_file_proposal'] },
      { name: 'Reviewer', access: 'propose', canApprove: false, canConfigure: false },
    ]);
    expect(result.current.created).toEqual({ name: 'Reviewer', token: 'atm_2' });
    expect(onSettings).toHaveBeenCalledTimes(2);
  });
});
