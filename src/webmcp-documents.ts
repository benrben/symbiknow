import { api } from './api';
import { storedDocument, uploadedSource } from '../shared/file-transfer';
import type { UploadedSource } from '../shared/file-transfer';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { ToolResult } from './webmcp-types';
import { changed } from './webmcp-context';
import { canvasIdFrom, path, requiredCoordinate, requiredString, textResult } from './webmcp-arguments';

export async function openDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const blockId = requiredString(args, 'blockId');
  const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom(args)));
  const block = document.blocks.find(item => item.id === blockId);
  if (!block) throw new Error('Document not found.');
  return textResult(block);
}

export function blockKind(args: Record<string, unknown>): string {
  const allowed = ['markdown', 'html', 'slides', 'website', 'mdx'];
  return typeof args.kind === 'string' && allowed.includes(args.kind) ? args.kind : 'markdown';
}

export async function createDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const block = await api<CanvasBlock>(path(canvasIdFrom(args)), {
    method: 'POST',
    body: JSON.stringify(storedDocument({
      title: requiredString(args, 'title'), content: String(args.content ?? ''),
      kind: blockKind(args), x: args.x, y: args.y,
    })),
  });
  changed();
  return textResult(block);
}

export async function uploadFile(args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.content !== 'string') throw new Error('content must contain the entire file source.');
  const source = uploadedSource(requiredString(args, 'filename'), args.content);
  const canvasId = canvasIdFrom(args);
  const blockId = args.blockId === undefined ? undefined : requiredString(args, 'blockId');
  const title = args.title === undefined ? source.title : requiredString(args, 'title');
  const route = path(canvasId, blockId);
  const block = await api<CanvasBlock>(route, { method: blockId ? 'PUT' : 'POST',
    body: JSON.stringify(uploadBody(args, source, blockId, title)),
  });
  changed();
  return textResult({ ...block, overwritten: Boolean(blockId) });
}

function uploadBody(args: Record<string, unknown>, source: UploadedSource, blockId: string | undefined, title: string) {
  if (blockId) return { content: source.content, kind: source.kind, ...(args.title === undefined ? {} : { title }) };
  return { title, content: source.content, kind: source.kind, x: args.x, y: args.y };
}

export async function downloadFile(args: Record<string, unknown>): Promise<ToolResult> {
  const blockId = requiredString(args, 'blockId');
  const canvas = await api<CanvasDocument>('/canvases/' + encodeURIComponent(canvasIdFrom(args)));
  const block = canvas.blocks.find(item => item.id === blockId);
  if (!block) throw new Error('Document not found.');
  return textResult({ blockId, filename: block.file.split('/').at(-1), title: block.title,
    kind: block.kind, content: block.content });
}

export function editPatch(args: Record<string, unknown>): Record<string, unknown> {
  const patch = Object.fromEntries(['title', 'content', 'kind']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  if (!Object.keys(patch).length) throw new Error('Provide a title, content, or kind to edit.');
  return patch;
}

export async function editDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const block = await api<CanvasBlock>(path(canvasIdFrom(args), requiredString(args, 'blockId')), {
    method: 'PUT', body: JSON.stringify(storedDocument(editPatch(args))),
  });
  changed();
  return textResult(block);
}

export async function removeDoc(args: Record<string, unknown>): Promise<ToolResult> {
  const result = await api(path(canvasIdFrom(args), requiredString(args, 'blockId')), { method: 'DELETE' });
  changed();
  return textResult(result);
}

export async function moveBlock(args: Record<string, unknown>): Promise<ToolResult> {
  const x = requiredCoordinate(args, 'x');
  const y = requiredCoordinate(args, 'y');
  const block = await api<CanvasBlock>(path(canvasIdFrom(args), requiredString(args, 'blockId')), {
    method: 'PUT', body: JSON.stringify({ x, y }),
  });
  changed();
  return textResult(block);
}

export async function moveDocument(args: Record<string, unknown>): Promise<ToolResult> {
  const route = path(canvasIdFrom(args), requiredString(args, 'blockId')) + '/move';
  const result = await api(route, { method: 'POST', body: JSON.stringify({ targetCanvasId: requiredString(args, 'targetCanvasId') }) });
  changed();
  return textResult(result);
}
