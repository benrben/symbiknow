import type { AnswerCanvasTurn, AnswerSource, ResearchCanvasBlock } from '../shared/answer-canvas';
import { patchFromMarkdown } from '../shared/research-patch';
import type { ResearchBlock } from './research-canvas-types';

export const sourceKey = (source: AnswerSource) => `${source.canvasId}:${source.blockId}`;
export function markdownForResearchBlock(block: Pick<ResearchBlock, 'title' | 'content' | 'sources'>): string {
  const references = block.sources.length ? `\n\n## Sources\n${block.sources.map((source, index) =>
    `${index + 1}. **${source.title}** — ${source.canvasName} (canvas ${source.canvasId}, document ${source.blockId})`).join('\n')}` : '';
  return `# ${block.title}\n\n${block.content.trim()}${references}\n`;
}

export function citedMarkdown(block: ResearchCanvasBlock, sources: AnswerSource[]): string {
  return markdownForResearchBlock({ ...block, sources: sources.filter(source => block.sourceIds.includes(sourceKey(source))) });
}

export function blocksForTurn(turn: AnswerCanvasTurn): ResearchCanvasBlock[] {
  return turn.patch?.blocks.length ? turn.patch.blocks : patchFromMarkdown(turn.query, turn.answer, turn.sources).blocks;
}

