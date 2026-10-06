import { type Viewport } from '@xyflow/react';

export const maxRememberedViewports = 8;

export function rememberViewport(viewports: Map<string, Viewport>, canvasId: string, viewport: Viewport): void {
  viewports.delete(canvasId);
  viewports.set(canvasId, viewport);
  if (viewports.size > maxRememberedViewports) viewports.delete(viewports.keys().next().value!);
}

/** Fitted content clears the breadcrumb bar above, the zoom controls on the left, and the hint bar and map below. */
export const canvasFitPadding = { top: '76px', right: '40px', bottom: '84px', left: '64px' } as const;
