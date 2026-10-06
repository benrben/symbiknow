import { useState } from 'react';
import type { JevWorkspaceModel } from './useJevWorkspace';
import { JevConnectionSettings } from './JevConnectionSettings';
import { JevAdvancedSettings } from './JevAdvancedSettings';

export function JevSettings({ model, canvasId }: { model: JevWorkspaceModel; canvasId: string }) {
  const [connecting, setConnecting] = useState(false);
  if (!model.state) return null;
  const { settings, hasApiKey, canConfigure } = model.state;
  return <section><h2>Automatic knowledge organization</h2>
    <p>The six actions run automatically on saved sources and workspace changes. Findings and saved changes appear in this panel.</p>
    {hasApiKey ? <p>Your TypeSafe key is saved. No requests or approvals are needed.</p> : <p>A TypeSafe API key is required for analysis. Work starts automatically when a key is available.</p>}
    {canConfigure ? <><JevConnectionSettings model={model} hasApiKey={hasApiKey} connecting={connecting} setConnecting={setConnecting}/>
      <label><input type="checkbox" checked={settings.paused} onChange={event => void model.send('settings', { paused: event.target.checked }, 'PUT')}/> Pause automatic work</label>
      <JevAdvancedSettings model={model} settings={settings} canvasId={canvasId}/></> : <p>Only the workspace owner can change connection settings.</p>}
  </section>;
}
