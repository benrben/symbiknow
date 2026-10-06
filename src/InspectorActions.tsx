import type { CanvasBlock } from '../shared/types';
import type { InspectorActions as Actions } from './useInspectorActions';

export function InspectorActions({ blocks, selected, actions, groupsEnabled = true }: { groupsEnabled?: boolean; blocks: CanvasBlock[]; selected: CanvasBlock[]; actions: Actions }) {
  const selectedIds = new Set(selected.map(block => block.id));
  return <div className="canvas-inspector__actions">
    {groupsEnabled && <><label>Group<input aria-label="Group selected documents" value={actions.group} onChange={event => actions.setGroup(event.target.value)} placeholder="Research/Benchmarks"/></label>
    <button type="button" onClick={actions.applyGroup}>Set group</button></>}
    <label>Tag<input aria-label="Tag selected documents" value={actions.tag} onChange={event => actions.setTag(event.target.value)} placeholder="important"/></label>
    <button type="button" onClick={actions.applyTag}>Add tag</button>
    <label>Connect to<select aria-label="Connection target" value={actions.target} onChange={event => actions.setTarget(event.target.value)}>
      <option value="">Choose document</option>{blocks.filter(block => !selectedIds.has(block.id)).map(block => <option key={block.id} value={block.id}>{block.title}</option>)}
    </select></label><button type="button" onClick={actions.connectTarget} disabled={!actions.target}>Connect selected</button>
  </div>;
}
