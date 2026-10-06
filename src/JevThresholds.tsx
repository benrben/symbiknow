import { useEffect, useRef, useState } from 'react';
import { jevActions, type JevCurrentAction } from '../shared/jev-types';
import { jevActionLabels } from '../shared/jev-action-labels';
import type { JevWorkspaceModel } from './useJevWorkspace';
import { useStableEvent } from './useStableEvent';

const descriptions: Record<JevCurrentAction, string> = {
  profile: 'Read purpose and key passages.', file: 'Place documents in shared groups.', label: 'Add relevant labels.',
  suggest_home_canvas: 'Choose a suitable canvas.', link: 'Connect related documents.', flag_duplicate: 'Check matching content.',
};

/** The panel already says it is opening; a second loading line here only stacked up. */
export function JevThresholds({ model }: { model: JevWorkspaceModel }) {
  const state = model.state;
  if (!state) return null;
  return <section className="jev-thresholds" aria-label="Automatic action thresholds"><h2>Automatic action thresholds</h2>
    <p>Minimum confidence for automatic decisions. Edits save when you leave a field.</p>
    <table><thead><tr><th scope="col">Action</th><th scope="col">Confidence</th></tr></thead>
      <tbody>{jevActions.map(action => <ThresholdRow key={action} action={action} model={model}
        percent={Math.round((state.settings.confidenceThresholds?.[action] ?? 0.7) * 10000) / 100} canConfigure={state.canConfigure}/>)}</tbody></table>
    {!state.canConfigure && <p>Only the workspace owner can change thresholds.</p>}
  </section>;
}

function ThresholdRow({ action, model, percent, canConfigure }: { action: JevCurrentAction; model: JevWorkspaceModel; percent: number; canConfigure: boolean }) {
  const [draft, setDraft] = useState(String(percent));
  const [error, setError] = useState('');
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(String(percent)); }, [percent]);
  const save = useStableEvent(async () => {
    const value = Number(draft);
    if (!draft.trim() || !(value >= 50 && value <= 100)) { setError('Use 50% to 100%.'); return; }
    setError('');
    if (value === percent) { dirty.current = false; return; }
    const result = await model.send('settings', { confidenceThresholds: { [action]: value / 100 } }, 'PUT');
    if (result !== undefined) dirty.current = false;
  });
  const label = `${jevActionLabels[action]} confidence threshold`;
  return <tr><th scope="row"><strong>{jevActionLabels[action]}</strong><small>{descriptions[action]}</small></th>
    <td><label><span className="sr-only">{label}</span><input type="number" inputMode="decimal" min="50" max="100" step="any"
      aria-label={label} aria-invalid={Boolean(error)} disabled={!canConfigure || model.busy} value={draft}
      onChange={event => { dirty.current = true; setDraft(event.target.value); setError(''); }} onBlur={() => void save()}/><span>%</span></label>
      {error && <small className="jev-error" role="alert">{error}</small>}</td></tr>;
}
