import { type Node, type Viewport } from '@xyflow/react';
import type { CanvasViewFocus } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { Theme } from './theme';

export type CanvasNodeData = Record<string, unknown> & {
  block: CanvasBlock;
  canvasId: string;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onOpenBlock: (block: CanvasBlock) => void;
  onReadBlock: (block: CanvasBlock) => void;
  onHistoryBlock: (block: CanvasBlock) => void;
  onOpenCrossLink: (canvasId: string, blockId: string) => void;
  onFindSimilar?: (blockId: string) => void;
  crossLinkLabels?: Record<string, string>;
  relatedLinks?: Array<{ block: CanvasBlock; direction: 'in' | 'out'; relation?: string }>;
  onResize: (blockId: string, patch: Partial<CanvasBlock>) => void;
  onError: (message: string) => void;
  highlighted: boolean;
  dimmed?: boolean;
  searchMatch?: boolean;
  activeSearch?: boolean;
  detail?: 'full' | 'titles';
};

export type GroupNodeData = Record<string, unknown> & {
  group: string;
  title: string;
  count: number;
  tone: number;
  width: number;
  height: number;
  depth: number;
  collapsed: boolean;
  overview: boolean;
  kind?: 'super' | 'files';
  topTitles: string[];
  internalLinkCount?: number;
  externalLinkCount?: number;
  onDrill: (group: string) => void;
  onCollapse: (group: string) => void;
  onHover: (group: string | null) => void;
};

export type CanvasNode = Node<CanvasNodeData, 'document'>;

export type GroupNode = Node<GroupNodeData, 'groupFrame'>;

export type FlowNode = CanvasNode | GroupNode;

export type BlockPosition = { blockId: string; x: number; y: number; group?: string | null };

export type Frame = {
  id: string;
  group: string;
  title: string;
  count: number;
  tone: number;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  members: string[];
  topTitles: string[];
  kind?: 'super' | 'files';
};

export interface CanvasProps {
  canvas: CanvasDocument;
  theme?: Theme;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onDeleteBlock: (blockId: string) => Promise<void>;
  onSelectBlock: (block: CanvasBlock) => void;
  onReadBlock?: (block: CanvasBlock) => void;
  onHistoryBlock?: (block: CanvasBlock) => void;
  onOpenCrossLink?: (canvasId: string, blockId: string) => void;
  onFindSimilar?: (blockId: string) => void;
  crossLinkLabels?: Record<string, string>;
  onMoveBlocks?: (positions: BlockPosition[]) => Promise<void>;
  focusRequest?: { blockId: string; sequence: number };
  fitRequest?: number;
  groupFocusRequest?: { canvasId: string; group: string; sequence: number };
  searchQuery?: string;
  searchMatchIds?: string[];
  activeSearchId?: string;
  onSummarizeSelection?: (blocks: CanvasBlock[]) => void;
  onSelectionChange?: (blocks: CanvasBlock[]) => void;
  onViewportChange?: (viewport: Viewport, visibleBlockIds: string[], focus: CanvasViewFocus) => void;
  viewportRequest?: Viewport & { sequence: number };
  focusZoom?: number;
  focusSelect?: boolean;
}
