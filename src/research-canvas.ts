import type { AnswerCanvasTurn, AnswerSource, ResearchCanvasBlock, ResearchLayout } from '../shared/answer-canvas';
import type { BlockKind } from '../shared/types';
import { storedDocument } from '../shared/file-transfer';
import { patchFromMarkdown } from '../shared/research-patch';

export type ResearchBlock = {
  id: string;
  turnId: number;
  type: ResearchCanvasBlock['type'];
  title: string;
  content: string;
  markdown: string;
  sources: AnswerSource[];
  x: number;
  y: number;
  lane?: string;
  kind?: BlockKind;
  width?: number;
  height?: number;
  group?: string | null;
  tags?: string[];
};
export type ResearchEdge = { source: string; target: string; label: string };

const sourceKey = (source: AnswerSource) => `${source.canvasId}:${source.blockId}`;
const CARD_WIDTH = 400;
const CARD_HEIGHT = 290;
const COLUMN_STEP = CARD_WIDTH + 120;
const ROW_STEP = CARD_HEIGHT + 100;

export function markdownForResearchBlock(block: Pick<ResearchBlock, 'title' | 'content' | 'sources'>): string {
  const references = block.sources.length ? `\n\n## Sources\n${block.sources.map((source, index) =>
    `${index + 1}. **${source.title}** — ${source.canvasName} (canvas ${source.canvasId}, document ${source.blockId})`).join('\n')}` : '';
  return `# ${block.title}\n\n${block.content.trim()}${references}\n`;
}

function citedMarkdown(block: ResearchCanvasBlock, sources: AnswerSource[]): string {
  return markdownForResearchBlock({ ...block, sources: sources.filter(source => block.sourceIds.includes(sourceKey(source))) });
}

function blocksForTurn(turn: AnswerCanvasTurn): ResearchCanvasBlock[] {
  return turn.patch?.blocks.length ? turn.patch.blocks : patchFromMarkdown(turn.query, turn.answer, turn.sources).blocks;
}

function connectedOrder(blocks: ResearchCanvasBlock[], edges: Array<{ from: string; to: string }>): {
  blocks: ResearchCanvasBlock[]; depth: Map<string, number>; linked: Set<string> } {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const incoming = new Map(blocks.map(block => [block.id, 0]));
  const outgoing = new Map(blocks.map(block => [block.id, [] as string[]]));
  const linked = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    linked.add(edge.from);
    linked.add(edge.to);
  }
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

export function researchMarkdown(turn: AnswerCanvasTurn): string {
  return blocksForTurn(turn).map(block => citedMarkdown(block, turn.sources)).join('\n---\n\n');
}

function laneForBlock(block: ResearchCanvasBlock, layout: ResearchLayout): number {
  const text = `${block.title} ${block.content.slice(0, 200)}`.toLocaleLowerCase();
  if (layout === 'kanban') {
    if (/next|action|task|todo|implement|ship|fix/u.test(text)) return 2;
    if (/risk|unknown|gap|question|uncertain|block/u.test(text)) return 0;
    return 1;
  }
  if (/outcome|decision|recommend|impact|next/u.test(text)) return 2;
  if (/component|system|flow|how|architecture|service|diagram/u.test(text)) return 1;
  return 0;
}

export function researchGraph(turns: AnswerCanvasTurn[], layout: ResearchLayout): { blocks: ResearchBlock[]; edges: ResearchEdge[] } {
  const laneNames = layout === 'kanban' ? ['Open questions', 'Evidence', 'Next actions'] : ['Context', 'System', 'Outcome'];
  const laneCounts = [0, 0, 0];
  const blocks: ResearchBlock[] = [];
  const edges: ResearchEdge[] = [];
  let clusterTop = 0;
  for (const turn of turns) {
    if (turn.status === 'working' && !turn.patch) continue;
    const patch = turn.patch?.blocks.length ? turn.patch : patchFromMarkdown(turn.query, turn.answer, turn.sources);
    const { blocks: local, depth, linked } = connectedOrder(patch.blocks, patch.edges);
    const columnCounts = new Map<number, number>();
    const depthCounts = new Map<number, number>();
    const globalId = (id: string) => `${turn.id}:${id}`;
    const prior = [...blocks].reverse().find(block => local.some(item => item.sourceIds.some(id => block.sources.some(source => sourceKey(source) === id))));
    const related = prior && local.find(item => item.sourceIds.some(id => prior.sources.some(source => sourceKey(source) === id)));
    if (prior && related) edges.push({ source: prior.id, target: globalId(related.id), label: 'shared evidence' });
    for (const edge of patch.edges) {
      if (local.some(block => block.id === edge.from) && local.some(block => block.id === edge.to))
        edges.push({ source: globalId(edge.from), target: globalId(edge.to), label: edge.label || 'connects' });
    }
    for (const [localIndex, localBlock] of local.entries()) {
      const document = storedDocument({ kind: localBlock.kind ?? 'markdown', content: localBlock.content });
      let x = 0;
      let y = clusterTop;
      let lane = localBlock.lane;
      if (layout === 'mindmap') {
        const level = Math.min(depth.get(localBlock.id) ?? 0, 4);
        const row = depthCounts.get(level) ?? 0;
        depthCounts.set(level, row + 1);
        x = level * COLUMN_STEP;
        y = clusterTop + row * ROW_STEP + (level === 0 && local.length > 1 ? 145 : 0);
      } else if (layout === 'architecture') {
        const column = linked.has(localBlock.id) ? Number((depth.get(localBlock.id) ?? 0) > 0) : localIndex % 2;
        x = column * COLUMN_STEP;
        y = clusterTop + (columnCounts.get(column) ?? 0) * ROW_STEP;
        columnCounts.set(column, (columnCounts.get(column) ?? 0) + 1);
        lane = lane ?? laneNames[laneForBlock(localBlock, layout)];
      } else if (layout === 'kanban') {
        const column = lane ? Math.max(0, laneNames.findIndex(name => name.toLowerCase() === lane?.toLowerCase())) : laneForBlock(localBlock, layout);
        lane = laneNames[column];
        x = column * COLUMN_STEP;
        y = laneCounts[column]++ * ROW_STEP;
      } else if (layout === 'roadmap') {
        x = localIndex % 2 ? COLUMN_STEP : 0;
        y = clusterTop + Math.floor(localIndex / 2) * ROW_STEP;
      }
      blocks.push({ id: globalId(localBlock.id), turnId: turn.id, type: localBlock.type, title: localBlock.title,
        kind: document.kind as BlockKind, content: document.content,
        markdown: citedMarkdown({ ...localBlock, content: document.content }, turn.sources),
        sources: turn.sources.filter(source => localBlock.sourceIds.includes(sourceKey(source))), x, y, lane });
    }
    if (layout === 'mindmap') clusterTop += Math.max(1, ...depthCounts.values()) * ROW_STEP + 180;
    else if (layout === 'architecture') clusterTop += Math.max(1, ...columnCounts.values()) * ROW_STEP + 180;
    else if (layout === 'roadmap') clusterTop += Math.max(1, Math.ceil(local.length / 2)) * ROW_STEP + 180;
  }
  return { blocks, edges };
}

export function exportResearchMarkdown(turns: AnswerCanvasTurn[], layout: ResearchLayout): string {
  const graph = researchGraph(turns, layout);
  const connections = graph.edges.length ? `\n## Connections\n${graph.edges.map(edge => {
    const from = graph.blocks.find(block => block.id === edge.source)?.title ?? edge.source;
    const to = graph.blocks.find(block => block.id === edge.target)?.title ?? edge.target;
    return `- ${from} → ${to} (${edge.label})`;
  }).join('\n')}\n` : '';
  return `# Research canvas: ${turns[0]?.query ?? 'Untitled'}\n\nLayout: ${layout}\n\n${graph.blocks.map(block => block.markdown).join('\n---\n\n')}${connections}`;
}
