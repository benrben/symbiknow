import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas';
import { blocksForTurn, citedMarkdown } from './research-canvas-content';
import { researchGraph } from './research-graph';

export type { ResearchBlock, ResearchEdge } from './research-canvas-types';
export { markdownForResearchBlock } from './research-canvas-content';
export { researchGraph } from './research-graph';

export function researchMarkdown(turn: AnswerCanvasTurn): string {
  return blocksForTurn(turn).map(block => citedMarkdown(block, turn.sources)).join('\n---\n\n');
}

export function exportResearchMarkdown(turns: AnswerCanvasTurn[], layout: ResearchLayout): string {
  const graph = researchGraph(turns, layout);
  const connections = graph.edges.length ? `\n## Connections\n${graph.edges.map(edge => {
    // researchGraph emits only authored edges with known endpoints or links to an existing prior block.
    const from = graph.blocks.find(block => block.id === edge.source)!.title;
    const to = graph.blocks.find(block => block.id === edge.target)!.title;
    return `- ${from} → ${to} (${edge.label})`;
  }).join('\n')}\n` : '';
  return `# Research canvas: ${turns[0]?.query ?? 'Untitled'}\n\nLayout: ${layout}\n\n${graph.blocks.map(block => block.markdown).join('\n---\n\n')}${connections}`;
}
