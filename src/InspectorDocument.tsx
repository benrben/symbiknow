import { FileText, Info } from 'lucide-react';
import type { CanvasInspectorProps } from './canvas-inspector-types';
import { BlockContent } from './Loaders';

export type InspectorMode = 'preview' | 'details';
export function InspectorTabs({ mode, onChange }: { mode: InspectorMode; onChange: (mode: InspectorMode) => void }) {
  return <div className="canvas-inspector__tabs" role="tablist" aria-label="Document panel view">
    <button type="button" role="tab" id="canvas-inspector-preview-tab" aria-controls="canvas-inspector-preview" aria-label="Preview" title="Document preview"
      aria-selected={mode === 'preview'} onClick={() => onChange('preview')}><FileText size={18} strokeWidth={1.8}/></button>
    <button type="button" role="tab" id="canvas-inspector-details-tab" aria-controls="canvas-inspector-details" aria-label="Details" title="Document details"
      aria-selected={mode === 'details'} onClick={() => onChange('details')}><Info size={18} strokeWidth={1.8}/></button>
  </div>;
}
export function InspectorDocument({ selected, canvasId, onUpdateBlock, onError, onReadBlock }: CanvasInspectorProps) {
  const first = selected[0];
  return <section className="canvas-inspector__document" role="tabpanel" id="canvas-inspector-preview" aria-labelledby="canvas-inspector-preview-tab">
    <div className="canvas-inspector__document-body"><BlockContent block={first} canvasId={canvasId} onUpdateBlock={onUpdateBlock} onError={onError}/></div>
    <footer><button type="button" onClick={() => onReadBlock(first)}>Open full document ↗</button></footer>
  </section>;
}
