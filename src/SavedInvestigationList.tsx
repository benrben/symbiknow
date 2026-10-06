import type { SavedInvestigationsModel } from './useSavedInvestigations';
export function SavedInvestigationList({ model }: { model: SavedInvestigationsModel }) {
  const { refresh, loading, busy } = model;
  return <><div className="saved-investigations__list-heading"><strong>In this workspace</strong><button type="button" onClick={() => void refresh()} disabled={loading || busy}>Refresh</button></div>
    <InvestigationCollection model={model} /></>;
}
function InvestigationCollection({ model }: { model: SavedInvestigationsModel }) {
  const { loading, items, error, open, busy } = model;
  if (loading) return <p role="status">Loading investigations…</p>;
  if (!items.length) return error ? null : <p>No saved investigations yet.</p>;
  return <ul>{items.map(item => <li key={item.id}><div><strong>{item.title}</strong><small>{item.visibility === 'private' ? 'Private in this browser' : 'Shared'} · {item.messageCount} messages · {new Date(item.updatedAt).toLocaleDateString()}</small></div>
    <button type="button" onClick={() => void open(item)} disabled={busy}>Open</button></li>)}</ul>;
}
