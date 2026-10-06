import type { ToolResult } from './webmcp-types';
import { activeCanvas } from './webmcp-context';

export function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function canvasIdFrom(args: Record<string, unknown>) {
  const id = typeof args.canvasId === 'string' && args.canvasId.trim() ? args.canvasId.trim() : activeCanvas();
  if (!id) throw new Error('Open a canvas before using this tool, or provide canvasId.');
  return id;
}

export function requiredString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required.');
  return value.trim();
}

export function path(canvasId: string, blockId?: string) {
  const base = '/canvases/' + encodeURIComponent(canvasId) + '/blocks';
  return blockId ? base + '/' + encodeURIComponent(blockId) : base;
}

export function requiredCoordinate(args: Record<string, unknown>, key: 'x' | 'y'): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('x and y must be finite numbers.');
  return value;
}
