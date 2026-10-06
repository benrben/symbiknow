import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isHtmlDocument, uploadedSource } from '../shared/file-transfer.js';
import type { CanvasBlock } from '../shared/types.js';
import { CanvasApi, canvasPath } from './mcp-api.js';

export type UploadArgs = { canvasId: string; blockId?: string; filename?: string; sourcePath?: string;
  content?: string; title?: string; x?: number; y?: number; expectedContentHash?: string; message?: string; idempotencyKey?: string };

type ValidUploadArgs = UploadArgs & ({ content: string; sourcePath?: undefined } | { sourcePath: string; content?: undefined });
function validateSource(args: UploadArgs): asserts args is ValidUploadArgs {
  if (args.content !== undefined && args.sourcePath !== undefined) throw new Error('Provide content or sourcePath, not both.');
  if (args.content === undefined && args.sourcePath === undefined) throw new Error('Provide the complete file content.');
}
async function uploadSource(args: ValidUploadArgs): Promise<string> {
  if (args.sourcePath === undefined) return args.content;
  const file = path.resolve(args.sourcePath);
  if ((await stat(file)).size > 999_900) throw new Error('The file is too large for a canvas document.');
  return readFile(file, 'utf8');
}
function uploadName(args: UploadArgs) {
  const filename = args.filename ?? (args.sourcePath ? path.basename(args.sourcePath) : undefined);
  if (!filename) throw new Error('filename is required when uploading content.');
  return filename;
}
async function uploadInput(args: UploadArgs) {
  validateSource(args);
  const source = await uploadSource(args);
  return uploadedSource(uploadName(args), source);
}

function uploadedBlock(block: CanvasBlock, overwritten: boolean) {
  return { ...block, ...(isHtmlDocument(block.content) ? { kind: 'html', storageKind: block.kind } : {}), overwritten };
}

async function replaceFile(api: CanvasApi, args: UploadArgs, source: { content: string; kind: string }, title: string) {
  const block = await api.request<CanvasBlock>(canvasPath(args.canvasId, args.blockId), 'PUT', {
    content: source.content, kind: source.kind, ...(args.title === undefined ? {} : { title }),
    expectedContentHash: args.expectedContentHash, ...(args.message ? { message: args.message } : {}),
  });
  return uploadedBlock(block, true);
}

async function createFile(api: CanvasApi, args: UploadArgs, source: { content: string; kind: string }, title: string) {
  const block = await api.request<CanvasBlock>(canvasPath(args.canvasId) + '/blocks', 'POST', {
    title, kind: source.kind, content: source.content, x: args.x, y: args.y, idempotencyKey: args.idempotencyKey,
  });
  return uploadedBlock(block, false);
}

export async function uploadFile(api: CanvasApi, args: UploadArgs) {
  const source = await uploadInput(args);
  const title = args.title ?? source.title;
  if (args.blockId && !args.expectedContentHash) throw new Error('expectedContentHash from read_doc is required to replace a document.');
  return args.blockId ? replaceFile(api, args, source, title) : createFile(api, args, source, title);
}

export async function downloadFile(api: CanvasApi, args: { canvasId: string; blockId: string; destinationPath?: string; overwrite?: boolean }) {
  const block = await api.block(args.canvasId, args.blockId);
  const filename = path.basename(block.file);
  if (args.destinationPath) await writeFile(path.resolve(args.destinationPath), block.content, { flag: args.overwrite ? 'w' : 'wx' });
  return { blockId: block.id, filename, title: block.title, kind: isHtmlDocument(block.content) ? 'html' : block.kind,
    ...(isHtmlDocument(block.content) ? { storageKind: block.kind } : {}), contentHash: block.contentHash,
    content: block.content, ...(args.destinationPath ? { savedTo: path.resolve(args.destinationPath) } : {}) };
}
