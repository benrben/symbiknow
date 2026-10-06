import type { SavedInvestigationsModel } from './useSavedInvestigations';
export function SavedInvestigationFreshness({ model }: { model: SavedInvestigationsModel }) {
  const { sourceChecks, sourceCheckError, uncheckedSources } = model;
  return <>          {sourceChecks === null && <p role="status">Checking saved sources against current documents…</p>}
    {sourceCheckError && <p role="status">Source freshness could not be checked: {sourceCheckError}. Reopen this investigation to retry.</p>}
    {uncheckedSources.length > 0 && <p role="status">{uncheckedSources.length} source{uncheckedSources.length === 1 ? '' : 's'} cannot be compared because a saved or current hash is unavailable.</p>}
  </>;
}
export function SavedInvestigationComparison({ model }: { model: SavedInvestigationsModel }) {
  const { changedSources, onRecheck } = model;
  const selected = model.selected!;
  if (!changedSources.length) return null;
  return <div className="saved-investigations__stale" role="status">
    <strong>{changedSources.length} source{changedSources.length === 1 ? '' : 's'} changed since this investigation was saved</strong>
    <p>Earlier answers may need updating. Compare the saved context with the current document, then recheck the answer.</p>
    {onRecheck && <button type="button" onClick={() => onRecheck(selected, changedSources)}>Recheck answer against current sources</button>}
    <details><summary>Compare source context</summary><ul>{changedSources.map(check => <li key={`${check.canvasId}:${check.blockId}`}>
      <strong>{check.title}</strong><small>Saved hash {check.oldHash ?? 'unavailable'} · Current hash {check.currentHash ?? 'document missing'}</small>
      <div><section><b>Saved context</b><p>{check.savedExcerpt ?? 'No saved passage available.'}</p></section>
        <section><b>Current document beginning</b><p>{check.currentExcerpt ?? 'Document no longer available.'}</p></section></div>
    </li>)}</ul></details>
  </div>;
}
