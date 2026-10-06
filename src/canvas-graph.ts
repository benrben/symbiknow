import { useCallback, useMemo } from 'react';
import type { CanvasViewFocus } from '../shared/answer-canvas';
import { groupPath, groupTone, normalizedGroup } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';
import { frames, groupEdges, groupPrefix, hierarchyEdges, makeEdges } from './canvas-flow-helpers';
import { makeSupergroups } from './canvas-hierarchy';
import { focusedEdges, relatedIds } from './canvas-interactions';
import type { CanvasState } from './canvas-state';
import type { CanvasProps, Frame } from './canvas-types';
import { groupDisplayLabel } from './canvas-group-labels';
import { drillLayout, drillPosition } from './canvas-drill-layout';

export function useCanvasGraph(props: CanvasProps, state: CanvasState) {
  const { canvas: { id: canvasId, blocks, groupLabels }, theme = 'light', searchMatchIds = [], searchQuery = '', activeSearchId } = props;
  const { zoom, mapPinned, selectedIds, focusHops, drillGroup, activeSupergroup, mapParent, hoveredGroup, nodes } = state;
  const viewBlocks = blocks;
  const zoomLevel = canvasDetail(zoom, mapPinned, fittedGroupActive(state));
  const searchIds = useMemo(() => new Set(searchMatchIds), [searchMatchIds]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const focusIds = useMemo(() => selectedIds.length === 1 ? relatedIds(blocks, selectedIds[0], focusHops) : null, [blocks, selectedIds, focusHops]);
  const drillPositions = useMemo(() => drillLayout(viewBlocks, drillGroup), [viewBlocks, drillGroup]);
  const livePositions = useMemo(() => new Map(nodes.filter(node => node.data.canvasId === canvasId).map(node => [node.id, {
    ...drillPosition(drillPositions, node), width: node.width ?? node.data.block.width, height: node.height ?? node.data.block.height,
  }])), [canvasId, nodes, drillPositions]);
  const groupFrames = useMemo(() => frames(viewBlocks, livePositions, groupLabels), [viewBlocks, livePositions, groupLabels]);
  const supergroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const block of viewBlocks) {
      const root = groupPath(normalizedGroup(block.group) ?? '__ungrouped')[0];
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    return makeSupergroups([...counts].map(([group, count]) => ({ group, count, title: group === '__ungrouped' ? 'Ungrouped' : groupDisplayLabel(group, groupLabels), tone: group === '__ungrouped' ? 7 : groupTone(group) })), viewBlocks);
  }, [viewBlocks, groupLabels]);
  const supergroupByRoot = useMemo(() => new Map(supergroups.flatMap(supergroup => supergroup.rootGroups.map(group => [group, supergroup.id] as const))), [supergroups]);
  const activeSuper = supergroups.find(supergroup => supergroup.id === activeSupergroup);
  const mapFrames = useMemo<Frame[]>(() => {
    if (mapParent) {
      const parentPath = groupPath(mapParent);
      const children = groupFrames.filter(frame => {
        const path = groupPath(frame.group);
        return path.length === parentPath.length + 1 && path[parentPath.length - 1] === mapParent;
      });
      const direct = viewBlocks.filter(block => (normalizedGroup(block.group) ?? '__ungrouped') === mapParent);
      const directFrame: Frame[] = direct.length && children.length ? [{ id: groupPrefix + `files:${mapParent}`, group: `files:${mapParent}`, title: 'Files in this group', count: direct.length,
        tone: groupTone(mapParent), depth: 0, x: 0, y: 0, width: 820, height: 550, members: direct.map(block => block.id), topTitles: direct.slice(0, 3).map(block => block.title), kind: 'files' }] : [];
      return [...children, ...directFrame];
    }
    if (activeSuper) return groupFrames.filter(frame => frame.depth === 0 && activeSuper.rootGroups.includes(frame.group));
    if (supergroups.length) return supergroups.map(supergroup => ({ id: groupPrefix + supergroup.id, group: supergroup.id, title: supergroup.title, count: supergroup.rootGroups.length,
      tone: supergroup.tone, depth: 0, x: 0, y: 0, width: 820, height: 550, members: [], topTitles: supergroup.topTitles.slice(0, 3), kind: 'super' }));
    return groupFrames.filter(frame => frame.depth === 0);
  }, [mapParent, groupFrames, viewBlocks, activeSuper, supergroups]);
  const mapGroupForBlock = useCallback((block: CanvasBlock): string | undefined => {
    const group = normalizedGroup(block.group) ?? '__ungrouped';
    const path = groupPath(group);
    if (mapParent) {
      return subgroupForPath(path, mapParent);
    }
    const root = path[0];
    if (activeSuper) return activeSuper.rootGroups.includes(root) ? root : undefined;
    return supergroups.length ? supergroupByRoot.get(root) : root;
  }, [mapParent, activeSuper, supergroups.length, supergroupByRoot]);
  const edges = useMemo(() => {
    if (zoomLevel === 'overview') return hierarchyEdges(viewBlocks, theme, mapGroupForBlock, hoveredGroup);
    const links = makeEdges(viewBlocks, theme);
    const focusedLinks = focusIds ? links.filter(edge => focusIds.has(edge.source) && focusIds.has(edge.target))
      : searchQuery.trim() ? focusedEdges(links, activeSearchId ? relatedIds(viewBlocks, activeSearchId, 1) : new Set<string>()) : links;
    if (zoomLevel === 'titles') return [
      ...groupEdges(viewBlocks, theme, zoomLevel, hoveredGroup),
      ...focusedLinks.map(edge => ({ ...edge, className: 'canvas-document-edge is-condensed',
        style: { ...edge.style, strokeWidth: 4, opacity: .85 },
        labelStyle: { ...edge.labelStyle, fontSize: 18 },
        markerEnd: typeof edge.markerEnd === 'object' && edge.markerEnd
          ? { ...edge.markerEnd, width: 18, height: 18 } : edge.markerEnd,
      })),
    ];
    if (focusIds) return links.filter(edge => focusIds.has(edge.source) && focusIds.has(edge.target)).map(edge => ({ ...edge, style: { ...edge.style, strokeWidth: 3, opacity: 1 } }));
    if (searchQuery.trim()) return focusedEdges(links, activeSearchId ? relatedIds(viewBlocks, activeSearchId, 1) : new Set<string>());
    return [...groupEdges(viewBlocks, theme), ...links.map(edge => ({ ...edge, className: 'canvas-document-edge',
      style: { ...edge.style, strokeWidth: 2.5, opacity: .7 } }))];
  }, [viewBlocks, theme, zoomLevel, hoveredGroup, focusIds, searchQuery, activeSearchId, mapGroupForBlock]);
  const visibleFrames = useMemo(() => groupFrames.filter(frame => !drillGroup || frame.group === drillGroup || groupPath(frame.group).includes(drillGroup)), [groupFrames, drillGroup]);
  const viewFocus = useMemo<CanvasViewFocus>(() => ({
    level: viewFocusLevel(zoomLevel, mapParent),
    activeGroup: drillGroup || mapParent || undefined,
    visibleGroups: (zoomLevel === 'overview' ? mapFrames.flatMap(frame => frame.kind === 'super'
      ? supergroups.filter(supergroup => supergroup.id === frame.group).flatMap(supergroup => supergroup.rootGroups) : [frame.group.replace(/^files:/u, '')])
      : visibleFrames.map(frame => frame.group)).filter((group, index, groups) => groups.indexOf(group) === index).slice(0, 16),
  }), [zoomLevel, mapParent, drillGroup, mapFrames, supergroups, visibleFrames]);
  const selectedBlocks = useMemo(() => blocks.filter(block => selectedIdSet.has(block.id)), [blocks, selectedIdSet]);
  return { viewBlocks, zoomLevel, searchIds, selectedIdSet, focusIds, drillPositions, livePositions, groupFrames, supergroups, supergroupByRoot, activeSuper, mapFrames, mapGroupForBlock, edges, visibleFrames, viewFocus, selectedBlocks };
}

export type CanvasGraph = ReturnType<typeof useCanvasGraph>;

function fittedGroupActive({ pointRequest, drillGroup, fittedGroup }: Pick<CanvasState, 'pointRequest' | 'drillGroup' | 'fittedGroup'>) {
  if (!fittedGroup || !drillGroup) return false;
  return fittedGroup.group === drillGroup && fittedGroup.sequence === pointRequest?.sequence;
}

/** A fitted group reveals documents until a subsequent zoom takes ownership of their detail. */
function canvasDetail(zoom: number, mapPinned: boolean, fittedGroup: boolean) {
  if (mapPinned || zoom < .34) return 'overview';
  return !fittedGroup && zoom < .75 ? 'titles' : 'full';
}

function subgroupForPath(path: string[], parent: string): string | undefined {
  const depth = groupPath(parent).length;
  if (path[depth - 1] !== parent) return undefined;
  return path[depth] ?? `files:${parent}`;
}

function viewFocusLevel(zoomLevel: string, mapParent: string): CanvasViewFocus['level'] {
  if (zoomLevel === 'overview') return mapParent ? 'subgroups' : 'groups';
  return zoomLevel === 'titles' ? 'groups' : 'documents';
}
