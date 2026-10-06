import { useState } from 'react';
import { api } from './api';
import type { JevWorkspaceModel } from './useJevWorkspace';
import { workspaceFailure } from './jev-workspace-status';

function cannotSaveKey(key: string, busy: boolean): boolean { return !key.trim() || busy; }
export function JevConnectionSettings({ model, hasApiKey, connecting, setConnecting }: {
  model: JevWorkspaceModel; hasApiKey: boolean; connecting: boolean; setConnecting: (value: boolean) => void;
}) {
  const [key, setKey] = useState(''); const [error, setError] = useState(''); const [connection, setConnection] = useState('');
  async function testConnection() {
    setConnection('');
    if (await model.send('connection')) setConnection('TypeSafe connection verified. No documents were sent.');
  }
  async function saveKey() {
    setConnecting(true); setError(''); setConnection('');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ secrets: { TYPESAFE_API_KEY: key.trim() } }) });
      setKey('');
      await model.send('settings', { externalProcessing: true, paused: false }, 'PUT');
      await model.refresh(); await testConnection();
    } catch (failure) { setError(workspaceFailure(failure, 'Provider key could not be saved')); }
    finally { setConnecting(false); }
  }
  const busy = model.busy || connecting;
  return <><label>TypeSafe API key<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)}/></label>
    <button type="button" disabled={cannotSaveKey(key, busy)} onClick={() => void saveKey()}>{connecting ? 'Connecting TypeSafe…' : 'Connect TypeSafe'}</button>
    {hasApiKey && <button type="button" disabled={busy} onClick={() => void testConnection()}>Test TypeSafe connection</button>}
    {connection && <p role="status">{connection}</p>}{error && <p role="alert">{error}</p>}
  </>;
}
