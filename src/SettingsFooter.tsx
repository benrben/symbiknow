
export function SettingsFooter({ saveError, busy, onCancel }: { saveError: string; busy: boolean; onCancel: () => void }) {
  return <footer className="settings-page__footer"><span role={saveError ? 'alert' : 'status'}>{saveError || (busy ? 'Saving Settings…' : 'Changes here are pending until Settings is saved. Token actions take effect immediately.')}</span><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></footer>;
}
