import type { ResearchCanvasBlock, ResearchLayout } from '../shared/answer-canvas';
import type { connectedOrder } from './research-graph-order';

type Ordered = ReturnType<typeof connectedOrder>;
export type GraphPlacement = { laneNames: string[]; laneCounts: number[]; columnCounts: Map<number, number>; depthCounts: Map<number, number>; clusterTop: number };
const COLUMN_STEP = 520;
const ROW_STEP = 390;

export function graphPlacement(layout: ResearchLayout): GraphPlacement {
  return { laneNames: layout === 'kanban' ? ['Open questions', 'Evidence', 'Next actions'] : ['Context', 'System', 'Outcome'],
    laneCounts: [0, 0, 0], columnCounts: new Map(), depthCounts: new Map(), clusterTop: 0 };
}

function kanbanLane(text: string) {
  if (/next|action|task|todo|implement|ship|fix/u.test(text)) return 2;
  if (/risk|unknown|gap|question|uncertain|block/u.test(text)) return 0;
  return 1;
}
function laneForBlock(block: ResearchCanvasBlock, layout: ResearchLayout): number {
  const text = `${block.title} ${block.content.slice(0, 200)}`.toLocaleLowerCase();
  if (layout === 'kanban') return kanbanLane(text);
  if (/outcome|decision|recommend|impact|next/u.test(text)) return 2;
  if (/component|system|flow|how|architecture|service|diagram/u.test(text)) return 1;
  return 0;
}

function mindmapPosition(block: ResearchCanvasBlock, graph: Ordered, state: GraphPlacement) {
  // connectedOrder initializes the depth of every local document, including cyclic ones.
  const level = Math.min(graph.depth.get(block.id)!, 4);
  const row = state.depthCounts.get(level) ?? 0;
  state.depthCounts.set(level, row + 1);
  return { x: level * COLUMN_STEP, y: state.clusterTop + row * ROW_STEP + (level === 0 && graph.blocks.length > 1 ? 145 : 0), lane: block.lane };
}

function architecturePosition(block: ResearchCanvasBlock, index: number, graph: Ordered, state: GraphPlacement) {
  const column = graph.linked.has(block.id) ? Number(graph.depth.get(block.id)! > 0) : index % 2;
  const x = column * COLUMN_STEP;
  const y = state.clusterTop + (state.columnCounts.get(column) ?? 0) * ROW_STEP;
  state.columnCounts.set(column, (state.columnCounts.get(column) ?? 0) + 1);
  return { x, y, lane: block.lane ?? state.laneNames[laneForBlock(block, 'architecture')] };
}

function kanbanPosition(block: ResearchCanvasBlock, state: GraphPlacement) {
  const column = block.lane ? Math.max(0, state.laneNames.findIndex(name => name.toLowerCase() === block.lane!.toLowerCase())) : laneForBlock(block, 'kanban');
  return { x: column * COLUMN_STEP, y: state.laneCounts[column]++ * ROW_STEP, lane: state.laneNames[column] };
}

export function positionBlock(layout: ResearchLayout, block: ResearchCanvasBlock, index: number, graph: Ordered, state: GraphPlacement) {
  switch (layout) {
    case 'mindmap': return mindmapPosition(block, graph, state);
    case 'architecture': return architecturePosition(block, index, graph, state);
    case 'kanban': return kanbanPosition(block, state);
    case 'roadmap': return { x: index % 2 ? COLUMN_STEP : 0, y: state.clusterTop + Math.floor(index / 2) * ROW_STEP, lane: block.lane };
    default: return { x: 0, y: state.clusterTop, lane: block.lane };
  }
}

export function advanceCluster(layout: ResearchLayout, state: GraphPlacement, count: number) {
  switch (layout) {
    case 'mindmap': state.clusterTop += Math.max(1, ...state.depthCounts.values()) * ROW_STEP + 180; break;
    case 'architecture': state.clusterTop += Math.max(1, ...state.columnCounts.values()) * ROW_STEP + 180; break;
    case 'roadmap': state.clusterTop += Math.max(1, Math.ceil(count / 2)) * ROW_STEP + 180; break;
  }
}
