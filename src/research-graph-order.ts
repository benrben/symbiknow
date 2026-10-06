import type { ResearchCanvasBlock } from '../shared/answer-canvas';

function wireEdges(edges: Array<{ from: string; to: string }>, graph: {
  byId: Map<string, ResearchCanvasBlock>; outgoing: Map<string, string[]>; incoming: Map<string, number>; linked: Set<string>;
}) {
  for (const edge of edges) {
    if (!graph.byId.has(edge.from) || !graph.byId.has(edge.to) || edge.from === edge.to) continue;
    graph.outgoing.get(edge.from)!.push(edge.to);
    graph.incoming.set(edge.to, graph.incoming.get(edge.to)! + 1);
    graph.linked.add(edge.from);
    graph.linked.add(edge.to);
  }
}

export function connectedOrder(blocks: ResearchCanvasBlock[], edges: Array<{ from: string; to: string }>): {
  blocks: ResearchCanvasBlock[]; depth: Map<string, number>; linked: Set<string> } {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const incoming = new Map(blocks.map(block => [block.id, 0]));
  const outgoing = new Map(blocks.map(block => [block.id, [] as string[]]));
  const linked = new Set<string>();
  wireEdges(edges, { byId, outgoing, incoming, linked });
  const queue = blocks.filter(block => incoming.get(block.id) === 0).map(block => block.id);
  const ordered: ResearchCanvasBlock[] = [];
  const depth = new Map(blocks.map(block => [block.id, 0]));
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const target of outgoing.get(id)!) {
      depth.set(target, Math.max(depth.get(target)!, depth.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const seen = new Set(ordered.map(block => block.id));
  return { blocks: [...ordered, ...blocks.filter(block => !seen.has(block.id))], depth, linked };
}
