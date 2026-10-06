import type { AnswerSource, ResearchCanvasBlock } from '../shared/answer-canvas';
import type { BlockKind } from '../shared/types';

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

