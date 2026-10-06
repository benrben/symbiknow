import type { SavedInvestigationsModel } from './useSavedInvestigations';
export function SavedInvestigationNotices({ model }: { model: SavedInvestigationsModel }) {
  const { unreadableKey, receipt, error, refresh } = model;
  return <>{unreadableKey && <p className="saved-investigations__key" role="alert">Saved privately, but this browser could not store its access key. Copy this key now: <code>{unreadableKey}</code></p>}
    {receipt && <p role="status" className="saved-investigations__receipt">{receipt}</p>}
    {error && <div role="alert" className="saved-investigations__error"><p>{error}</p><button type="button" onClick={() => void refresh()}>Retry list</button></div>}</>;
}
