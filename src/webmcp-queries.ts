import { api } from './api';
import type { CanvasDocument } from '../shared/types';
import type { ToolResult } from './webmcp-types';
import { canvasIdFrom, requiredString, textResult } from './webmcp-arguments';

export async function searchDocs(args: Record<string, unknown>): Promise<ToolResult> {
  return textResult(await api('/search?q=' + encodeURIComponent(requiredString(args, 'query'))));
}

export async function readActiveCanvas(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom({})));
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(document) }] };
}
