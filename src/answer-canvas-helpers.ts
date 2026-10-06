import type { AnswerSource, ResearchLayout } from '../shared/answer-canvas';
import type { ResearchBlock } from './research-canvas';

export const sourceKey = (source: AnswerSource) => source.canvasId + ':' + source.blockId;
export const sourcePassage = (source: AnswerSource) => source.evidence?.passage?.trim() ? source.evidence.passage : source.excerpt;
export const layoutNames: Record<ResearchLayout, string> = { roadmap: 'Roadmap', kanban: 'Kanban', architecture: 'Architecture', mindmap: 'Mind map' };
export const newId = () => 'user:' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
export const roomForBlock = (blocks: ResearchBlock[], anchor?: ResearchBlock, width = 400, height = 290) => {
  const x = anchor ? anchor.x + (anchor.width ?? 400) + 120 : 80;
  let y = anchor?.y ?? 80;
  while (blocks.some(block => x < block.x + (block.width ?? 400) + 80 && x + width + 80 > block.x
    && y < block.y + (block.height ?? 290) + 80 && y + height + 80 > block.y)) y += Math.max(height + 100, 390);
  return { x, y };
};
