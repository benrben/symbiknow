import { useRef, useState } from 'react';
import type { AppDialogModel } from './app-dialog-contract';
import { cycleModalFocus, useModalFocus } from './app-modal-focus';
import { Icon } from './AppIcon';
import { SettingsPage } from './SettingsPage';
import { VersionPanel } from './VersionPanel';
import type { BlockDraft, Dialog } from './app-model-helpers';
import { BlockForm } from './AppDocumentEditor';
import { useEscapeLayer } from './escape-layers';
export { FullPageReader } from './AppDocumentReader';

export function ModalOverlay({ model }: { model: AppDialogModel }) {
  const { dialog, busy, setDialog } = model;
  const modalRef = useRef<HTMLDivElement>(null);
  const originalDraft = useRef(JSON.stringify(model.draftBlock));
  const [confirmClose, setConfirmClose] = useState(false);
  const captureDraftFocus = useModalFocus(modalRef, confirmClose);
  const dirty = dialog === 'block' && JSON.stringify(model.draftBlock) !== originalDraft.current;
  function close() {
    if (busy) return;
    if (dirty) { captureDraftFocus(); setConfirmClose(true); }
    else setDialog(null);
  }
  useEscapeLayer(true, close);
  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    if (!confirmClose && !isModalEditor(model)) return;
    cycleModalFocus(focusScope(modalRef.current, confirmClose), event);
  }
  return <div className="overlay modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={modalRef} onKeyDown={trapFocus} className={modalClass(dialog)} role="dialog" aria-modal={isModalEditor(model) ? 'true' : 'false'} aria-label={modalLabel(dialog)}>
      <ModalHeading model={model} onClose={close}/>
      <ModalContent model={model} onClose={close}/>
      <FormError model={model}/>
      <DirtyCloseWarning open={confirmClose} onContinue={() => setConfirmClose(false)} onDiscard={() => setDialog(null)}
        onSave={() => { setConfirmClose(false); modalRef.current?.querySelector<HTMLFormElement>('form.modal-form')?.requestSubmit(); }}/>
    </div>
  </div>;
}

function modalLabel(dialog: Dialog) {
  if (dialog === 'delete-canvas') return 'Delete canvas';
  if (dialog === 'delete-workspace') return 'Delete workspace';
  if (dialog === 'settings') return 'Settings';
  if (dialog === 'block') return 'Document editor';
  if (dialog === 'versions') return 'History and branches';
  return 'Create new';
}

function ModalContent({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  if (model.dialog === 'delete-canvas') return <DeleteCanvasForm model={model}/>;
  if (model.dialog === 'delete-workspace') return <DeleteWorkspaceForm model={model}/>;
  if (model.dialog === 'settings') return <SettingsPage settings={model.settings} busy={model.busy} onSave={model.saveSettings} onCancel={onClose} onSettings={model.setSettings} onOpenHistory={model.openActivityHistory}/>;
  if (model.dialog === 'block') return <BlockForm model={model} onClose={onClose}/>;
  if (model.dialog === 'versions') return <VersionDialogContent model={model}/>;
  return <NamedForm model={model}/>;
}

function modalHeading(dialog: Dialog, draft: BlockDraft) {
  if (dialog === 'delete-canvas') return { eyebrow: 'REMOVE CANVAS', title: 'Delete canvas?' };
  if (dialog === 'delete-workspace') return { eyebrow: 'REMOVE WORKSPACE', title: 'Delete workspace?' };
  if (dialog === 'settings') return { eyebrow: 'WORKSPACE SETTINGS', title: 'Connections and agents' };
  if (dialog === 'block') return blockHeading(draft);
  if (dialog === 'versions') return { eyebrow: 'DOCUMENT HISTORY', title: 'File revisions and branches' };
  return namedHeading(dialog);
}

function DeleteCanvasForm({ model }: { model: AppDialogModel }) {
  const target = model.canvasToDelete;
  if (!target) return null;
  return <div className="modal-form">
    <p>Delete <strong>{target.name}</strong> and all its documents and file histories? This cannot be undone.</p>
    {model.error && <p className="delete-canvas-error" role="alert">{model.error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setDialog(null)} disabled={model.busy} autoFocus>Cancel</button><button type="button" className="danger-button delete-canvas-confirm" onClick={() => void model.deleteCanvas()} disabled={model.busy}><Icon name="trash" size={16}/>{model.busy ? 'Deleting…' : 'Delete canvas'}</button></div>
  </div>;
}

function DeleteWorkspaceForm({ model }: { model: AppDialogModel }) {
  const target = model.workspaceToDelete;
  if (!target) return null;
  return <div className="modal-form">
    <p>Delete <strong>{target.name}</strong> and its {target.canvases.length} {target.canvases.length === 1 ? 'canvas' : 'canvases'}, including all documents and file histories? This cannot be undone.</p>
    {model.error && <p className="delete-canvas-error" role="alert">{model.error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => model.setDialog(null)} disabled={model.busy} autoFocus>Cancel</button><button type="button" className="danger-button delete-workspace-confirm" onClick={() => void model.deleteWorkspace()} disabled={model.busy}><Icon name="trash" size={16}/>{model.busy ? 'Deleting…' : 'Delete workspace'}</button></div>
  </div>;
}

function ModalHeading({ model, onClose }: { model: AppDialogModel; onClose: () => void }) {
  const { eyebrow, title } = modalHeading(model.dialog, model.draftBlock);
  return <div className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><div className="modal-heading__actions">
    {model.dialog === 'block' && <button type="button" className="secondary-button document-assistant-trigger" onClick={model.openDocumentAssistant}><Icon name="spark" size={15}/> Ask Symbi</button>}
    <button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={model.busy}><Icon name="close" size={19}/></button>
  </div></div>;
}

function NamedForm({ model }: { model: AppDialogModel }) {
  const { dialog, createNamed, draftName, setDraftName, busy, setDialog } = model;
  return <form onSubmit={createNamed} className="modal-form">
    <label>{dialog === 'workspace' ? 'Workspace name' : 'Canvas name'}<input autoFocus required value={draftName} onChange={event => setDraftName(event.target.value)} placeholder={dialog === 'workspace' ? 'e.g. Product team' : 'e.g. Launch plan'}/></label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={busy}>Create</button></div>
  </form>;
}

function isModalEditor(model: AppDialogModel) { return !(model.dialog === 'block' && model.showChat); }

function focusScope(modal: HTMLDivElement | null, warning: boolean) {
  return warning ? modal?.querySelector<HTMLElement>('.dirty-close') : modal;
}

function modalClass(dialog: Dialog) {
  if (dialog === 'settings') return 'modal settings-modal';
  if (dialog === 'block') return 'modal editor-modal block-modal';
  return dialog === 'versions' ? 'modal editor-modal history-modal' : 'modal ';
}

function DirtyCloseWarning({ open, onContinue, onDiscard, onSave }: {
  open: boolean; onContinue: () => void; onDiscard: () => void; onSave: () => void;
}) {
  useEscapeLayer(open, onContinue);
  if (!open) return null;
  return <div className="dirty-close" role="presentation">
    <div className="dirty-close__card" role="alertdialog" aria-modal="true" aria-label="Unsaved changes" aria-describedby="dirty-close-description">
      <h3>Unsaved changes</h3><p id="dirty-close-description">Save this document before closing, or discard your draft.</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onContinue} autoFocus>Continue editing</button>
        <button type="button" className="danger-button" onClick={onDiscard}>Discard changes</button>
        <button type="button" className="primary-button" onClick={onSave}>Save changes</button></div>
    </div>
  </div>;
}

function blockHeading(draft: BlockDraft) { return { eyebrow: 'MARKDOWN FILE', title: draft.id ? 'Edit document' : 'New document' }; }
function namedHeading(dialog: Dialog) { return { eyebrow: 'CREATE NEW', title: dialog === 'workspace' ? 'New workspace' : 'New canvas' }; }

function VersionDialogContent({ model }: { model: AppDialogModel }) {
  const block = model.canvas?.blocks.find(item => item.id === model.versionBlockId);
  return block ? <VersionPanel canvasId={model.canvasId} block={block} initialRevision={model.versionRevision} onChanged={model.refreshAfterVersionChange}/> : null;
}

const formDialogs: Dialog[] = ['block', 'canvas', 'workspace'];
function FormError({ model }: { model: AppDialogModel }) {
  if (!formDialogs.includes(model.dialog)) return null;
  return model.error && <p className="delete-canvas-error" role="alert">{model.error}</p>;
}
