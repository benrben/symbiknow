import { useState } from 'react';
import type { BlockKind, WorkspaceSummary } from '../shared/types';

export type IntakeSuggestion = { canvasId: string; purpose?: string; workArea?: string; tags: string[];
  linkTargets: Array<{ blockId: string; title: string; confidence: number }> };
export type IntakeDraft = { fileName: string; title: string; kind: BlockKind; sourceCanvasId: string;
  index: number; total: number; suggestion: IntakeSuggestion | null; previewing: boolean; error: string;
  errorStage?: 'preview' | 'save' };
export type IntakeSelection = { canvasId: string; purpose?: string; workArea?: string; tags: string[]; links: string[] };

export function SmartIntakeDialog({ draft, workspaces, busy, onSave, onSkip, onCancel }: {
  draft: IntakeDraft; workspaces: WorkspaceSummary[]; busy: boolean;
  onSave: (selection: IntakeSelection) => void; onSkip: () => void; onCancel: () => void;
}) {
  const [canvasId, setCanvasId] = useState(draft.suggestion?.canvasId ?? draft.sourceCanvasId);
  const [purpose, setPurpose] = useState(Boolean(draft.suggestion?.purpose));
  const [workArea, setWorkArea] = useState(Boolean(draft.suggestion?.workArea));
  const [tags, setTags] = useState(Boolean(draft.suggestion?.tags.length));
  const [links, setLinks] = useState(() => new Set(draft.suggestion?.linkTargets.map(link => link.blockId) ?? []));
  const workspace = workspaces.find(item => item.canvases.some(canvas => canvas.id === draft.sourceCanvasId));
  const canvases = workspace?.canvases ?? [];
  const validCanvas = canvases.some(canvas => canvas.id === canvasId) ? canvasId : draft.sourceCanvasId;
  const ready = !draft.previewing && !busy && draft.errorStage !== 'save';
  return <div className="overlay modal-overlay smart-intake-overlay" role="presentation">
    <div className="modal smart-intake" role="dialog" aria-modal="true" aria-label="Review Jev upload suggestions">
      <div className="modal-heading"><div><span className="eyebrow">JEV · DOCUMENT INTAKE</span><h2>Review before adding</h2></div>
        <button className="icon-button" type="button" aria-label="Cancel upload" onClick={onCancel} disabled={busy}>×</button></div>
      <div className="smart-intake__body">
        <p className="smart-intake__file"><strong>{draft.fileName}</strong><span>{draft.index + 1} of {draft.total} · {draft.kind}</span></p>
        {draft.previewing ? <p role="status">Jev is checking where this document fits…</p> : <>
          {draft.error && <p role="alert">{draft.errorStage === 'save'
            ? `Could not confirm whether this document was added: ${draft.error}. Close this review and inspect the destination canvas before trying again.`
            : `Suggestions are unavailable: ${draft.error}. Nothing has been added yet; you can still add this document.`}</p>}
          {!draft.suggestion && !draft.error && <p className="smart-intake__no-suggestions" style={{ margin: 0, padding: '12px', borderRadius: 9,
            background: 'var(--sk-surface, #f7f9fb)', color: 'var(--sk-muted, #63727b)', lineHeight: 1.5 }}>
            Jev has no suggestions for this file. You can still add it to the selected canvas without suggestions.
          </p>}
          <label className="smart-intake__destination">Add to canvas<select value={validCanvas} onChange={event => setCanvasId(event.target.value)}>
            {canvases.map(canvas => <option value={canvas.id} key={canvas.id}>{canvas.name}</option>)}
          </select></label>
          {draft.suggestion && <div className="smart-intake__suggestions">
            <p>Choose Jev suggestions to include</p>
            {draft.suggestion.purpose && <label><input type="checkbox" checked={purpose} onChange={event => setPurpose(event.target.checked)}/> Purpose: {draft.suggestion.purpose}</label>}
            {draft.suggestion.workArea && <label><input type="checkbox" checked={workArea} onChange={event => setWorkArea(event.target.checked)}/> Work area: {draft.suggestion.workArea}</label>}
            {draft.suggestion.tags.length > 0 && <label><input type="checkbox" checked={tags} onChange={event => setTags(event.target.checked)}/> Tags: {draft.suggestion.tags.join(', ')}</label>}
            {validCanvas !== draft.suggestion.canvasId && draft.suggestion.linkTargets.length > 0 &&
              <small>Suggested links belong to another canvas, so they will not be added here.</small>}
            {validCanvas === draft.suggestion.canvasId && draft.suggestion.linkTargets.map(link => <label key={link.blockId}><input type="checkbox" checked={links.has(link.blockId)} onChange={event => {
              setLinks(current => { const next = new Set(current); if (event.target.checked) next.add(link.blockId); else next.delete(link.blockId); return next; });
            }}/> Link to {link.title}</label>)}
          </div>}
          <div className="smart-intake__summary" aria-label="Upload summary" style={{ display: 'grid', gap: 4, padding: '12px',
            border: '1px solid var(--sk-border, #dae2e9)', borderRadius: 9 }}>
            <strong>Ready to add</strong><span>{draft.title || draft.fileName}</span>
            <small>Destination: {canvases.find(canvas => canvas.id === validCanvas)?.name ?? validCanvas}</small>
          </div>
        </>}
      </div>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={!ready} onClick={onSkip}>Skip this file</button>
        <span className="actions-spacer"/><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" disabled={!ready} onClick={() => onSave({ canvasId: validCanvas,
          ...(purpose && draft.suggestion?.purpose ? { purpose: draft.suggestion.purpose } : {}),
          ...(workArea && draft.suggestion?.workArea ? { workArea: draft.suggestion.workArea } : {}),
          tags: tags ? draft.suggestion?.tags ?? [] : [],
          links: validCanvas === draft.suggestion?.canvasId ? [...links] : [] })}>{busy ? 'Adding…' : 'Add document'}</button></div>
    </div>
  </div>;
}
