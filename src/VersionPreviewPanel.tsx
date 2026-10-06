import type { VersionPanelModel } from './useVersionPanel';
import type { VersionAction, VersionPreview } from './version-panel-types';

export function VersionPreviewPanel({ model }: { model: VersionPanelModel }) {
  if (!model.action) return null;
  return <section className="version-panel__preview" aria-label="Version preview">
    <h3>{model.action.label}</h3>
    {model.loadingPreview && <p role="status">Loading read-only preview. Saved content is unchanged…</p>}
    <PreviewContent model={model} />
    <PreviewActions action={model.action} model={model} />
  </section>;
}
function PreviewContent({ model }: { model: VersionPanelModel }) {
  if (!model.preview) return null;
  return <>
    <p><strong>Affected scope:</strong> {model.preview.scope}</p>
    <RevisionDetails model={model} preview={model.preview} />
    <div className="version-panel__comparison">
      <div><h4>Before</h4><pre>{model.preview.before || '(empty document)'}</pre></div>
      <div><h4>After</h4><pre>{model.preview.after || '(empty document)'}</pre></div>
    </div>
    <p>This preview has not changed saved content. Review the complete content above before applying.{model.action!.label.startsWith('Undo') ? ' Applying this undo saves a new revision.' : ''}</p>
  </>;
}
function RevisionDetails({ model, preview }: { model: VersionPanelModel; preview: VersionPreview }) {
  if (!preview.revision) return null;
  const revision = typeof preview.revision === 'string' ? model.status?.commits.find(commit => commit.id === preview.revision) : preview.revision;
  return <p><strong>Revision:</strong> {typeof preview.revision === 'string' ? preview.revision.slice(0, 12) : preview.revision.id.slice(0, 12)} · {revision?.author ?? 'Unknown author'} · {revision ? new Date(revision.createdAt).toLocaleString() : 'Date unavailable'}</p>;
}
function PreviewActions({ action, model }: { action: VersionAction; model: VersionPanelModel }) {
  return <div className="modal-actions">
    <button type="button" className="secondary-button" onClick={model.cancelPreview}>Cancel</button>
    <button type="button" className="primary-button" disabled={!model.preview || model.loadingPreview || model.busy} onClick={() => void model.apply()}>
      {model.busy ? 'Saving…' : 'Confirm ' + action.kind}
    </button>
  </div>;
}
