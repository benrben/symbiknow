import '@xyflow/react/dist/style.css';
import { useCanvasModel } from './canvas-model';
import type { CanvasProps } from './canvas-types';
import './canvas.css';
import { CanvasView } from './CanvasView';

export function Canvas(props: CanvasProps) {
  const model = useCanvasModel(props);
  return <CanvasView model={model}/>;
}

export type { BlockPosition,CanvasProps } from './canvas-types';
