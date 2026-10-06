import { useState } from 'react';
import type { CanvasInspectorProps } from './canvas-inspector-types';
import { InspectorResize } from './InspectorResize';
import { InspectorTabs, InspectorDocument, type InspectorMode } from './InspectorDocument';
import { InspectorDetails } from './InspectorDetails';
import { useInspectorActions } from './useInspectorActions';

export type { CanvasInspectorProps } from './canvas-inspector-types';

export function CanvasInspector(props: CanvasInspectorProps) {
  const actions = useInspectorActions(props);
  const [mode, setMode] = useState<InspectorMode>('preview');
  if (!props.selected.length) return null;
  const single = props.selected.length === 1;
  return <aside className="canvas-inspector" aria-label="Selection inspector">
    <InspectorResize onResize={props.onResize}/>
    <header className="canvas-inspector__header"><strong>{single ? props.selected[0].title : `${props.selected.length} documents selected`}</strong>
      <button type="button" onClick={props.onClose} aria-label="Close inspector">×</button></header>
    {single && <InspectorTabs mode={mode} onChange={setMode}/>}
    {single && mode === 'preview' ? <InspectorDocument {...props}/> : <InspectorDetails {...props} actions={actions}/>}
  </aside>;
}
