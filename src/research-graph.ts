import type { AnswerCanvasTurn, ResearchCanvasBlock, ResearchLayout } from '../shared/answer-canvas';
import type { BlockKind } from '../shared/types';
import { storedDocument } from '../shared/file-transfer';
import { patchFromMarkdown } from '../shared/research-patch';
import type { ResearchBlock, ResearchEdge } from './research-canvas-types';
import { citedMarkdown } from './research-canvas-content';
import { appendPatchEdges, appendSharedEvidence, citedSources } from './research-graph-evidence';
import { advanceCluster, graphPlacement, positionBlock } from './research-graph-layout';
import { connectedOrder } from './research-graph-order';

function patchForTurn(turn: AnswerCanvasTurn) {
  return turn.patch?.blocks.length ? turn.patch : patchFromMarkdown(turn.query, turn.answer, turn.sources);
}

function storedResearchDocument(block: ResearchCanvasBlock) {
  return storedDocument({ kind: block.kind ?? 'markdown', content: block.content });
}

function researchBlock(turn: AnswerCanvasTurn, block: ResearchCanvasBlock, document: ReturnType<typeof storedResearchDocument>, position: { x: number; y: number; lane?: string }): ResearchBlock {
  const id = `${turn.id}:${block.id}`;
  return { id, turnId: turn.id, type: block.type, title: block.title, kind: document.kind as BlockKind, content: document.content,
    markdown: citedMarkdown({ ...block, content: document.content }, turn.sources),
    sources: citedSources(block, turn.sources), ...position };
}

export function researchGraph(turns: AnswerCanvasTurn[], layout: ResearchLayout): { blocks: ResearchBlock[]; edges: ResearchEdge[] } {
  const state = graphPlacement(layout);
  const blocks: ResearchBlock[] = [];
  const edges: ResearchEdge[] = [];
  for (const turn of turns) {
    if (turn.status === 'working' && !turn.patch) continue;
    const patch = patchForTurn(turn);
    const ordered = connectedOrder(patch.blocks, patch.edges);
    state.columnCounts = new Map(); state.depthCounts = new Map();
    const globalId = (id: string) => `${turn.id}:${id}`;
    appendSharedEvidence(blocks, ordered.blocks, edges, globalId);
    appendPatchEdges(ordered.blocks, patch.edges, edges, globalId);
    for (const [index, block] of ordered.blocks.entries()) {
      const document = storedResearchDocument(block);
      const position = positionBlock(layout, block, index, ordered, state);
      blocks.push(researchBlock(turn, block, document, position));
    }
    advanceCluster(layout, state, ordered.blocks.length);
  }
  return { blocks, edges };
}
