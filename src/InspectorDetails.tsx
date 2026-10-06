import type { CanvasBlock } from '../shared/types';
import { groupLabel } from '../shared/groups';
import type { CanvasInspectorProps } from './canvas-inspector-types';
import { InspectorActions } from './InspectorActions';
import type { InspectorActions as Actions } from './useInspectorActions';

type DetailProps = Pick<CanvasInspectorProps, 'blocks' | 'selected' | 'onReadBlock' | 'onFocusBlock' | 'onSummarizeSelection' | 'groupsEnabled'> & { actions: Actions };
function excerpt(block: CanvasBlock): string {
  return block.content.replace(/[#>*_`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'No text preview';
}
function DocumentLinks({ heading, blocks, onFocusBlock }: { heading: string; blocks: CanvasBlock[]; onFocusBlock: CanvasInspectorProps['onFocusBlock'] }) {
  return <><h3>{heading}</h3>{blocks.length ? blocks.map(block => <button type="button" key={block.id} onClick={() => onFocusBlock(block.id)}>{block.title}</button>) : <p>None</p>}</>;
}
function SingleDetails({ blocks, selected, onReadBlock, onFocusBlock, groupsEnabled = true }: DetailProps) {
  const first = selected[0];
  const inbound = blocks.filter(block => block.links.includes(first.id));
  const outbound = first.links.map(id => blocks.find(block => block.id === id)).filter((block): block is CanvasBlock => Boolean(block));
  return <>
    <p className="canvas-inspector__meta">{first.file} · {first.kind}{groupsEnabled && <> · {first.group ? groupLabel(first.group) : 'Ungrouped'}</>}</p>
    <button type="button" onClick={() => onReadBlock(first)}>Open full document</button>
    <DocumentLinks heading="Links out" blocks={outbound} onFocusBlock={onFocusBlock}/>
    <DocumentLinks heading="Links in" blocks={inbound} onFocusBlock={onFocusBlock}/>
  </>;
}
function SelectionDetails({ selected, onSummarizeSelection, actions }: DetailProps) {
  const commonTags = (selected[0].tags ?? []).filter(value => selected.every(block => block.tags?.includes(value)));
  return <>
    <ul className="canvas-inspector__selected">{selected.map(block => <li key={block.id}>{block.title}</li>)}</ul>
    <h3>Combined summary</h3>
    <ul className="canvas-inspector__summary">{selected.map(block => <li key={block.id}><strong>{block.title}:</strong> {excerpt(block)}</li>)}</ul>
    <p>Shared tags: {commonTags.length ? commonTags.join(', ') : 'none'}</p>
    {onSummarizeSelection && <button type="button" onClick={() => onSummarizeSelection(selected)}>AI: summarize these</button>}
    <button type="button" onClick={actions.connectTogether}>Connect selected together</button>
  </>;
}
export function InspectorDetails(props: DetailProps) {
  const single = props.selected.length === 1;
  return <section className="canvas-inspector__details" role={single ? 'tabpanel' : undefined} id={single ? 'canvas-inspector-details' : undefined}
    aria-labelledby={single ? 'canvas-inspector-details-tab' : undefined}>
    {single ? <SingleDetails {...props}/> : <SelectionDetails {...props}/>}
    <InspectorActions groupsEnabled={props.groupsEnabled} blocks={props.blocks} selected={props.selected} actions={props.actions}/>
  </section>;
}
