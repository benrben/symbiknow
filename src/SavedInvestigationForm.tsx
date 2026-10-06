import type { SavedInvestigationsModel } from './useSavedInvestigations';
export function SavedInvestigationForm({ model }: { model: SavedInvestigationsModel }) {
  const { save, title, setTitle, visibility, setVisibility, busy, selected, newInvestigation } = model;
  const saveLabel = busy ? 'Saving…' : selected ? 'Save changes' : 'Save investigation';
  return <form onSubmit={event => void save(event)}>
    <label>Name<input aria-label="Investigation name" value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="Name this investigation" required /></label>
    <label>Access<select aria-label="Investigation access" value={visibility} onChange={event => setVisibility(event.target.value as 'private' | 'shared')}><option value="private">Private to this browser</option><option value="shared">Shared with workspace</option></select></label>
    <div className="saved-investigations__actions"><button type="submit" disabled={busy || !title.trim()}>{saveLabel}</button>
      {selected && <button type="button" onClick={newInvestigation} disabled={busy}>Save as new</button>}</div>
  </form>;
}
