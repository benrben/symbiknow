import { canvasGrouping, type InsightReport, type ReadingPath } from '../shared/insights.js';
import { normalizedGroup } from '../shared/groups.js';
import type { CanvasBlock, DocumentLane, GroupBy } from '../shared/types.js';

const laneOrder: Record<DocumentLane, number> = { overview: 0, work: 1, reference: 2, followup: 3 };

/** One named path per visible group, respecting prerequisite and decision links. */
export function buildReadingPaths(blocks: CanvasBlock[], report: Pick<InsightReport, 'readingOrder' | 'classification'>,
  groupBy: GroupBy): ReadingPath[] {
  const visible = blocks.filter(block => !block.archived);
  const byId = new Map(visible.map(block => [block.id, block]));
  const reading = new Map(report.readingOrder.map((entry, index) => [entry.blockId, { score: entry.score, index, lane: entry.lane }]));
  const classes = new Map((report.classification ?? []).map(entry => [entry.blockId, entry]));
  const priority = (block: CanvasBlock) => {
    const saved = normalizedGroup(block.group);
    const savedLane = saved?.startsWith('lane:') ? saved.slice(5) as DocumentLane : undefined;
    const lane = classes.get(block.id)?.lane ?? reading.get(block.id)?.lane ?? savedLane;
    return { score: reading.get(block.id)?.score ?? classes.get(block.id)?.order ?? 0.5,
      lane: lane ? laneOrder[lane] ?? 4 : 4, index: reading.get(block.id)?.index ?? Number.MAX_SAFE_INTEGER };
  };
  const compare = (left: string, right: string) => {
    const a = byId.get(left)!;
    const b = byId.get(right)!;
    const first = priority(a);
    const second = priority(b);
    return first.score - second.score || first.lane - second.lane || first.index - second.index
      || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  };

  return canvasGrouping(visible, report, groupBy).map(group => {
    const members = new Set(group.blockIds);
    const outgoing = new Map(group.blockIds.map(id => [id, new Set<string>()]));
    const indegree = new Map(group.blockIds.map(id => [id, 0]));
    for (const id of group.blockIds) {
      const block = byId.get(id)!;
      for (const target of block.links) {
        if (!members.has(target) || !['prerequisite', 'decision_for'].includes(block.linkTypes?.[target] ?? '')) continue;
        if (outgoing.get(id)!.has(target)) continue;
        outgoing.get(id)!.add(target);
        indegree.set(target, indegree.get(target)! + 1);
      }
    }

    const remaining = new Set(group.blockIds);
    const blockIds: string[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter(id => indegree.get(id) === 0);
      // A saved cycle cannot be topologically sorted. Break it at the block
      // with the earliest expected reading position so the path stays usable.
      const next = (ready.length ? ready : [...remaining]).sort(compare)[0];
      remaining.delete(next);
      blockIds.push(next);
      for (const target of outgoing.get(next)!) indegree.set(target, indegree.get(target)! - 1);
    }
    return { id: group.key, name: group.label, blockIds };
  });
}
