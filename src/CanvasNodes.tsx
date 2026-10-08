import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import type { CanvasBlock } from '../shared/types';
import { workAreaLabel } from '../shared/work-areas';
import { browserActor } from './api';
import type { CanvasNode, CanvasNodeData, GroupNode, GroupNodeData } from './canvas-types';
import { BlockContent } from './Loaders';
import { JevCardStatus } from './JevCardStatus';

export function LockBadge({ block }: { block: CanvasBlock }) {
  if (!block.lock || block.lock.owner === browserActor) return null;
  const until = new Date(block.lock.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return <em className="canvas-card__lock" title={`${block.lock.owner} is editing until ${until}${block.lock.note ? ` — ${block.lock.note}` : ''}`}>● {block.lock.owner} editing</em>;
}

export const DocumentNode = memo(function DocumentNode({ data, selected }: NodeProps<CanvasNode>) {
  const { block, canvasId, onUpdateBlock, onResize, onError } = data;
  return <article className={documentClass(data, selected)}>
    <NodeResizer isVisible={selected} minWidth={280} minHeight={200} color="var(--sk-focus)"
      onResizeEnd={(_, dimensions) => onResize(block.id, dimensions)}/>
    <Handle type="target" position={Position.Left} className="canvas-handle"/>
    <DocumentHeader data={data}/>
    <JevCardStatus block={block} onOpenRelated={id => data.onOpenCrossLink(canvasId, id)}/>
    <DocumentRelationships data={data}/>
    {data.detail !== 'titles' && <div className="canvas-card__body nowheel nodrag" onDoubleClick={event => event.stopPropagation()}>
      <BlockContent block={block} canvasId={canvasId} onUpdateBlock={onUpdateBlock} onError={onError}/>
    </div>}
    <Handle type="source" position={Position.Right} className="canvas-handle"/>
  </article>;
}, (previous, next) => previous.selected === next.selected && previous.data === next.data);

function documentClass(data: CanvasNodeData, selected: boolean) {
  const classes = { 'is-selected': selected, 'is-highlighted': data.highlighted || data.activeSearch,
    'is-search-match': data.searchMatch, 'is-dimmed': data.dimmed, 'is-title-only': data.detail === 'titles', 'is-locked': data.block.lock };
  return [`canvas-card canvas-card--${data.block.kind}`, ...Object.entries(classes).filter(([, enabled]) => enabled).map(([name]) => name)].join(' ');
}

function DocumentHeader({ data }: { data: CanvasNodeData }) {
  const { block, onReadBlock, onHistoryBlock, onOpenBlock } = data;
  return <header className="canvas-card__header">
        <span className="canvas-card__grip" aria-hidden="true">⠿</span>
        <div className="canvas-card__identity">
          <strong>{block.title}</strong>
          <small>{block.file}</small>
          <DocumentMetadata block={block}/>
        </div>
        <span className="canvas-card__kind">{block.kind}</span>
        <button className="canvas-card__edit nodrag" title="Open full page" aria-label={`Read ${block.title} full page`} onClick={() => onReadBlock(block)}>↗</button>
        <button className="canvas-card__edit nodrag" title="File history" aria-label={`History for ${block.title}`} onClick={() => onHistoryBlock(block)}>⑂</button>
        {data.onFindSimilar && <button type="button" className="canvas-card__edit nodrag" aria-label={`Find similar research blocks for ${block.title}`} onClick={event => { event.stopPropagation(); data.onFindSimilar?.(block.id); }}>≈</button>}
        <button className="canvas-card__edit nodrag" title="Edit Markdown file" aria-label={`Edit ${block.title}`} onClick={() => onOpenBlock(block)}>✎</button>
      </header>;
}

function DocumentMetadata({ block }: { block: CanvasBlock }) {
  if (![block.purpose, block.workArea, block.reviewer, block.lock, block.tags?.length].some(Boolean)) return null;
  return <span className="canvas-card__metadata">
    <LockBadge block={block}/>
    {block.purpose && <em className="canvas-card__purpose" data-purpose={block.purpose} title={`Purpose: ${block.purpose}`}>{block.purpose}</em>}
    {block.workArea && <em className={`canvas-card__work-area canvas-card__work-area--${labelTone(block.workArea)}`} title={`Work area: ${workAreaLabel(block.workArea)}`}>{workAreaLabel(block.workArea)}</em>}
    {block.reviewer && <em className="canvas-card__reviewer" title={`Reviewer: ${block.reviewer}`}>Review: {block.reviewer}</em>}
    <DocumentLabels block={block}/>
  </span>;
}

function DocumentLabels({ block }: { block: CanvasBlock }) {
  if (!block.tags?.length) return null;
  return <span className="canvas-card__labels" aria-label={`Labels for ${block.title}`} title={block.tags.join(', ')}>
    {block.tags.slice(0, 3).map(tag => <em key={tag} className="canvas-card__label">{tag}</em>)}
    {block.tags.length > 3 && <small>+{block.tags.length - 3}</small>}
  </span>;
}

function labelTone(value: string): number {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 6;
}

function DocumentRelationships({ data }: { data: CanvasNodeData }) {
  const links = data.relatedLinks ?? [];
  const portals = data.detail === 'titles' ? [] : data.block.crossLinks ?? [];
  const count = links.length + portals.length;
  if (!count) return null;
  return <nav className="canvas-card__relationships nowheel nodrag" aria-label={`Relationships for ${data.block.title}`}>
    <strong>{count} {count === 1 ? 'relationship' : 'relationships'}</strong>
    {links.map(link => <button type="button" key={`${link.direction}:${link.block.id}`} className="nodrag"
      title={`${link.direction === 'out' ? 'Links to' : 'Linked from'} ${link.block.title}${link.relation ? ` · ${link.relation.replaceAll('_', ' ')}` : ''}`}
      aria-label={`${link.direction === 'out' ? 'Open linked document' : 'Open linking document'} ${link.block.title}`}
      onClick={event => { event.stopPropagation(); data.onReadBlock(link.block); }}>
      {link.direction === 'out' ? '↗' : '↙'} {link.block.title}
    </button>)}
    {portals.map(link => <button key={`${link.canvasId}:${link.blockId}`} type="button" className="nodrag"
      aria-label={`Open related document ${link.blockId} on canvas ${link.canvasId}`}
      title={`Open ${link.blockId} on canvas ${link.canvasId}`}
      onClick={event => { event.stopPropagation(); data.onOpenCrossLink(link.canvasId, link.blockId); }}>
      ↗ Other canvas: {data.crossLinkLabels?.[`${link.canvasId}:${link.blockId}`] ?? link.canvasId}
    </button>)}
  </nav>;
}

export const GroupFrameNode = memo(function GroupFrameNode({ data, selected }: NodeProps<GroupNode>) {
  return <div className={groupFrameClass(data, selected)} style={{ width: data.width, height: data.height }}
    data-canvas-group={data.group}
    onClick={() => drillOverview(data)}
    onMouseEnter={() => hoverOverview(data, data.group)}
    onMouseLeave={() => hoverOverview(data, null)}
    aria-label={`${data.title} ${groupKind(data)}, ${data.count} ${groupNoun(data, false)}`}>
    <Handle type="target" position={Position.Left} className="canvas-group__handle" isConnectable={false}/>
    <GroupHeading data={data}/>
    <GroupSummary data={data}/>
    <Handle type="source" position={Position.Right} className="canvas-group__handle" isConnectable={false}/>
  </div>;
}, (previous, next) => {
  const before = previous.data;
  const after = next.data;
  return previous.selected === next.selected && (before === after || (groupDataFields.every(field => before[field] === after[field])
    && before.topTitles.length === after.topTitles.length
    && before.topTitles.every((title, index) => title === after.topTitles[index])));
});

function groupFrameClass(data: GroupNodeData, selected: boolean) {
  return [`canvas-group canvas-group--tone-${data.tone}`, data.overview && 'is-overview', selected && 'is-selected',
    data.collapsed && 'is-collapsed', data.kind && `is-${data.kind}`].filter(Boolean).join(' ');
}

function drillOverview(data: GroupNodeData) { if (data.overview) data.onDrill(data.group); }
function hoverOverview(data: GroupNodeData, group: string | null) { if (data.overview) data.onHover(group); }

function GroupSummary({ data }: { data: GroupNodeData }) {
  if (!data.overview && !data.collapsed) return null;
  return <div className="canvas-group__summary">
    <GroupInternalLinks data={data}/>
    <GroupExternalLinks data={data}/>
    {data.topTitles.map(title => <span key={title}>{title}</span>)}
  </div>;
}

function GroupInternalLinks({ data }: { data: GroupNodeData }) {
  if (!data.overview || !data.internalLinkCount) return null;
  return <span className="canvas-group__internal-links">↗ {data.internalLinkCount} {data.internalLinkCount === 1 ? 'link' : 'links'} inside</span>;
}

function GroupExternalLinks({ data }: { data: GroupNodeData }) {
  if (!data.overview || !data.externalLinkCount) return null;
  return <span className="canvas-group__external-links">↗ {data.externalLinkCount} {data.externalLinkCount === 1 ? 'link' : 'links'} beyond this group</span>;
}

const groupDataFields = ['group', 'title', 'count', 'tone', 'width', 'height', 'depth', 'collapsed',
  'overview', 'kind', 'internalLinkCount', 'externalLinkCount', 'onDrill', 'onCollapse', 'onHover'] as const;

function groupKind(data: GroupNodeData) { return data.kind === 'super' ? 'supergroup' : 'group'; }

function groupNoun(data: GroupNodeData, short: boolean) {
  if (data.kind === 'super') return data.count === 1 ? 'group' : 'groups';
  if (!short) return 'documents';
  return data.count === 1 ? 'doc' : 'docs';
}

function GroupHeading({ data }: { data: GroupNodeData }) {
  return <span className="canvas-group__heading" title={data.overview ? `Open ${data.title}` : 'Drag to move this group'} onMouseEnter={() => { if (data.overview) data.onHover(data.group); }} onMouseLeave={() => { if (data.overview) data.onHover(null); }}><span className="canvas-group__dot"/><button type="button" className="nodrag" onClick={event => { event.stopPropagation(); data.onDrill(data.group); }} title={`Open ${data.title}`}>{data.title}</button><small>{data.count} {groupNoun(data, true)}</small>{!data.overview && <button type="button" className="nodrag canvas-group__toggle" aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.title}`} onClick={event => { event.stopPropagation(); data.onCollapse(data.group); }}>{data.collapsed ? '+' : '−'}</button>}</span>;
}

export const nodeTypes = { document: DocumentNode, groupFrame: GroupFrameNode };
