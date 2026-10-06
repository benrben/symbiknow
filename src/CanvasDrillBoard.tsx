import type { CanvasBlock } from '../shared/types';
import { groupMembers } from './canvas-interactions';
import { countLabel, documentExcerpt, documentKindLabel, immediateGroups } from './canvas-overview-data';
import type { CanvasDrillBoardProps, OverviewGroup } from './canvas-overview-types';

export function CanvasDrillBoard({ group, groups, blocks, onFocus, onSelect }: CanvasDrillBoardProps) {
  const frame = groups.find(item => item.group === group);
  const children = immediateGroups(groups, group);
  const documents = groupMembers(blocks, group);
  const title = frame?.title ?? group;
  return <div className="canvas-drill-layer"><section className={`canvas-drill-board canvas-group--tone-${frame?.tone ?? 0}`} aria-label={`${title} group documents`}>
    <header className="canvas-drill-board__heading"><span aria-hidden="true">▤</span><div><h2>{title}</h2><p>{countLabel(documents.length, 'document', 'documents')}{subgroupLabel(children.length)}</p></div></header>
    <div className="canvas-drill-board__content">
      <ChildGroups children={children} onFocus={onFocus} />
      <div className="canvas-drill-board__section-heading"><strong>Documents in this group</strong><span>Choose a document to see it on the canvas</span></div>
      <div className="canvas-drill-board__documents">{documents.map(block => <DrillDocument key={block.id} block={block} group={group} onSelect={onSelect} />)}</div>
    </div>
  </section></div>;
}

function subgroupLabel(count: number) {
  return count ? ` · ${countLabel(count, 'subgroup', 'subgroups')}` : '';
}

function ChildGroups({ children, onFocus }: { children: OverviewGroup[]; onFocus: (group: string) => void }) {
  if (children.length === 0) return null;
  return <div className="canvas-drill-board__children">{children.map(child => <button type="button" key={child.id} onClick={() => onFocus(child.group)}><span aria-hidden="true">▣</span><strong>{child.title}</strong><small>{child.count} docs</small><b aria-hidden="true">›</b></button>)}</div>;
}

function DrillDocument({ block, group, onSelect }: { block: CanvasBlock; group: string; onSelect: (blockId: string) => void }) {
  return <button type="button" onClick={() => onSelect(block.id)}>
    <small>{documentKindLabel(block, group)}</small>
    <strong>{block.title}</strong>
    <span>{documentExcerpt(block.content)}</span>
    <em>View on canvas <span aria-hidden="true">↗</span></em>
  </button>;
}
