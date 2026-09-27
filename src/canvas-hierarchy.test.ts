import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { makeSupergroups, type RootGroup } from './canvas-hierarchy';

function root(index: number): RootGroup {
  return { group: `custom:group_${index}`, title: `Group ${index}`, count: index + 1, tone: index % 8 };
}

function block(group: string, links: string[] = []): CanvasBlock {
  return { id: group, title: group, group: `custom:${group}/notes`, file: `${group}.md`, kind: 'markdown', content: '', x: 0, y: 0, width: 240, height: 160, links };
}

describe('makeSupergroups', () => {
  it('shows the root map directly when it has fewer than nine groups', () => {
    expect(makeSupergroups(Array.from({ length: 8 }, (_, index) => root(index)), [])).toEqual([]);
  });

  it('keeps strongly linked root groups together even when documents are nested', () => {
    const roots = Array.from({ length: 12 }, (_, index) => root(index));
    const blocks = roots.map((item, index) => block(item.group.slice(7), roots
      .filter((_, other) => other !== index && Math.floor(other / 6) === Math.floor(index / 6))
      .map(other => other.group.slice(7))));
    const groups = makeSupergroups(roots, blocks);

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.rootGroups).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      roots.slice(0, 6).map(item => item.group).sort(),
      roots.slice(6).map(item => item.group).sort(),
    ]);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(roots.reduce((sum, item) => sum + item.count, 0));
    expect(groups.every(group => group.topTitles.length === 6 && group.topTitles.includes(group.title))).toBe(true);
  });

  it('distributes unlinked groups within the size limit and ignores input ordering', () => {
    const roots = Array.from({ length: 16 }, (_, index) => root(index));
    const forward = makeSupergroups(roots, []);
    const reverse = makeSupergroups([...roots].reverse(), []);

    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(3);
    expect(forward.map(group => group.id)).toEqual(['super:0', 'super:1', 'super:2']);
    expect(forward.every(group => group.rootGroups.length <= 6)).toBe(true);
    expect(forward.flatMap(group => group.rootGroups).sort()).toEqual(roots.map(item => item.group).sort());
  });
});
