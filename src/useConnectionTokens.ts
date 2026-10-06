import { useRef, useState } from 'react';
import type { ChatSettings, WorkspaceSummary } from '../shared/types';
import { api } from './api';
import { toolsForAccess } from './connection-scope';

type TokenInput = { name: string; access: 'read' | 'propose' | 'write'; canvasScope: 'all' | 'selected'; selectedCanvasIds: string[]; toolScope: 'all' | 'selected'; selectedTools: string[] };
function tokenPayload(input: TokenInput) {
  return { name: input.name.trim(), access: input.access,
    ...(input.canvasScope === 'selected' ? { allowedCanvasIds: input.selectedCanvasIds } : {}),
    ...(input.toolScope === 'selected' ? { tools: input.selectedTools } : {}) };
}
function invalidCanvasScope(scope: TokenInput['canvasScope'], ids: string[], workspaces: WorkspaceSummary[] | null): boolean {
  // The picker prevents adding more than 100 canvases; an unavailable list cannot authorize a selection.
  return scope === 'selected' && (ids.length === 0 || workspaces === null);
}

export function useConnectionTokens(workspaces: WorkspaceSummary[] | null, onSettings: (settings: ChatSettings) => void) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');
  const [access, setAccess] = useState<'read' | 'propose' | 'write'>('read');
  const [canvasScope, setCanvasScope] = useState<'all' | 'selected'>('all');
  const [selectedCanvasIds, setSelectedCanvasIds] = useState<string[]>([]);
  const [toolScope, setToolScope] = useState<'all' | 'selected'>('all');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const creating = useRef(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const availableTools = toolsForAccess(access);
  const scopeInvalid = invalidCanvasScope(canvasScope, selectedCanvasIds, workspaces)
    || (toolScope === 'selected' && selectedTools.length === 0);
  async function createToken() {
    if (!name.trim() || scopeInvalid || creating.current) return;
    creating.current = true; setCreatingToken(true);
    setError('');
    try {
      const result = await api<{ token: string; settings: ChatSettings }>('/mcp/tokens', { method: 'POST', body: JSON.stringify(tokenPayload({ name, access, canvasScope, selectedCanvasIds, toolScope, selectedTools })) });
      setCreated({ name: name.trim(), token: result.token });
      setName('');
      setCanvasScope('all'); setSelectedCanvasIds([]); setToolScope('all'); setSelectedTools([]);
      onSettings(result.settings);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create a token.'); }
    finally { creating.current = false; setCreatingToken(false); }
  }

  async function revoke(id: string, tokenName: string) {
    if (!window.confirm(`Revoke “${tokenName}” now? This takes effect immediately and connected clients will lose access.`)) return;
    setError('');
    try { onSettings(await api<ChatSettings>(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke the token.'); }
  }

  return { name, setName, created, error, access, setAccess, canvasScope, setCanvasScope, selectedCanvasIds, setSelectedCanvasIds, toolScope, setToolScope, selectedTools, setSelectedTools, availableTools, scopeInvalid, creatingToken, createToken, revoke };
}

export type ConnectionTokenModel = ReturnType<typeof useConnectionTokens>;
