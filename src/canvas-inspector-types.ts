import type { CanvasBlock } from '../shared/types';

export interface CanvasInspectorProps {
  blocks: CanvasBlock[];
  selected: CanvasBlock[];
  canvasId: string;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onReadBlock: (block: CanvasBlock) => void;
  onFocusBlock: (blockId: string) => void;
  onSummarizeSelection?: (blocks: CanvasBlock[]) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onResize: (axis: 'width' | 'height', size: number) => void;
}
