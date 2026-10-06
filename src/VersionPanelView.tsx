import type { VersionPanelModel } from './useVersionPanel';
import { VersionBranches } from './VersionBranches';
import { VersionRevisions } from './VersionRevisions';
import { VersionPreviewPanel } from './VersionPreviewPanel';

export function VersionPanelView({ model }: { model: VersionPanelModel }) {
  return <div className="version-panel">
    <p className="version-panel__intro"><strong>{model.block.title}</strong> · {model.block.file}<br />History affects this document's content only. Other documents and canvas positions stay in place.</p>
    <VersionError model={model} />
    <VersionReceipt model={model} />
    <VersionBranches model={model} />
    <VersionRevisions model={model} />
    <VersionPreviewPanel model={model} />
  </div>;
}
function VersionError({ model }: { model: VersionPanelModel }) {
  if (!model.error) return null;
  return <div className="version-panel__error" role="alert">
    <p>{model.error}</p>
    {model.action && !model.preview && !model.loadingPreview &&
      <button type="button" className="secondary-button" onClick={() => void model.choose(model.action!)}>Retry read-only preview</button>}
    <button type="button" className="secondary-button" disabled={model.loadingStatus} onClick={() => void model.refreshStatus()}>Reload saved history</button>
  </div>;
}
function VersionReceipt({ model }: { model: VersionPanelModel }) {
  if (!model.receipt) return null;
  return <div className="version-panel__receipt" role="status">
    <p>{model.receipt}</p>
    {model.undoRevision && <button type="button" className="secondary-button"
      onClick={() => void model.choose({ kind: 'restore', value: model.undoRevision, label: 'Undo by restoring ' + model.undoRevision.slice(0, 12) })}>
      Preview undo
    </button>}
  </div>;
}
