import { groupPath, normalizedGroup } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';
import { groupMembers } from './canvas-interactions';
import type { OverviewGroup } from './canvas-overview-types';


export function groupMatchCount(blocks: CanvasBlock[], group: string, searchIds: Set<string>) {
  return groupMembers(blocks, group).filter(block => searchIds.has(block.id)).length;
}

export function immediateGroups(groups: OverviewGroup[], parent: string) {
  const parentDepth = groupPath(parent).length;
  return groups.filter(item => item.group !== parent
    && groupPath(item.group).length === parentDepth + 1 && groupPath(item.group).includes(parent));
}

export function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function documentKindLabel(block: CanvasBlock, group: string) {
  const documentGroup = normalizedGroup(block.group);
  if (!documentGroup || documentGroup === group) return block.kind;
  return `${block.kind} · ${documentGroup.split('/').at(-1)}`;
}

export function documentExcerpt(content: string) {
  return content.slice(0, 2400).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<[^>]*>|[#*`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)
    || 'Open this document to read more.';
}
