import { useState } from 'react';
import type { JevWorkspaceModel } from './useJevWorkspace';

export function JevReset({ model }: { model: JevWorkspaceModel }) {
  const [pending, setPending] = useState(false);
  if (!model.state?.canConfigure) return null;
  const available = model.state.hasApiKey && model.state.settings.externalProcessing;
  async function reset() {
    setPending(true);
    await model.send('reset', {}, 'POST');
    setPending(false);
  }
  return <section className="jev-card" aria-label="Reset automatic organization">
    <p>Across this workspace, clears Jev-generated analysis and organization, then runs all 6 actions. Manual changes and source content remain.</p>
    {!available && <p role="status">A connected TypeSafe key and automatic processing are required to reset and rerun Jev.</p>}
    <button type="button" disabled={model.busy || !available} onClick={() => void reset()}>{pending ? 'Resetting Jev…' : 'Reset all Jev'}</button>
  </section>;
}
