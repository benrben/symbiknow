import { constants } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadedFile, FileUploadInput, FileUploadReceipt } from '../shared/working-copy.js';
import { packWebsiteWorkingCopy, unpackWebsiteWorkingCopy } from './local-website-working-copy.js';
import { CanvasApi } from './mcp-api.js';

export type UploadArgs = Omit<FileUploadInput, 'content' | 'filename'> & { content?: string; filename?: string; sourcePath?: string };
async function uploadContent(args: UploadArgs): Promise<string> {
  if ((args.content === undefined) === (args.sourcePath === undefined)) throw new Error('Provide exactly one of content or sourcePath.');
  if (args.sourcePath === undefined) return args.content!;
  const handle = await open(path.resolve(args.sourcePath), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('sourcePath must name a regular file.');
    if (info.size > 999_900) throw new Error('The file is too large for a canvas document.');
    const source = await handle.readFile('utf8');
    if (Buffer.byteLength(source) > 999_900) throw new Error('The file is too large for a canvas document.');
    return source;
  } finally { await handle.close(); }
}
export async function uploadFile(api: CanvasApi, args: UploadArgs): Promise<FileUploadReceipt> {
  if (await directorySource(args.sourcePath)) return uploadDirectory(api, args);
  const content = await uploadContent(args);
  const filename = args.filename ?? (args.sourcePath ? path.basename(args.sourcePath) : undefined);
  if (!filename) throw new Error('filename is required when uploading content.');
  const input = { ...args };
  delete input.sourcePath;
  return api.request<FileUploadReceipt>('/file-uploads', 'POST', { ...input, filename, content });
}
export async function downloadFile(api: CanvasApi, args: { canvasId: string; blockId: string; branch?: string;
  destinationPath?: string; overwrite?: boolean }): Promise<DownloadedFile> {
  const downloaded = await api.request<DownloadedFile>('/file-checkouts', 'POST', {
    canvasId: args.canvasId, blockId: args.blockId, ...(args.branch ? { branch: args.branch } : {}),
  });
  if (!args.destinationPath) return downloaded;
  if (downloaded.manifest.kind === 'website') {
    return { ...downloaded, ...(await unpackWebsiteWorkingCopy(path.resolve(args.destinationPath), downloaded, Boolean(args.overwrite))) };
  }
  const savedTo = path.resolve(args.destinationPath);
  const manifestPath = savedTo + '.symbi.json';
  const source = await openDownloadTarget(savedTo, Boolean(args.overwrite));
  try {
    const sidecar = await openDownloadTarget(manifestPath, Boolean(args.overwrite));
    try {
      const metadata = JSON.stringify(downloaded.manifest, null, 2);
      await source.handle.writeFile(downloaded.content);
      await source.handle.truncate(Buffer.byteLength(downloaded.content));
      await sidecar.handle.writeFile(metadata);
      await sidecar.handle.truncate(Buffer.byteLength(metadata));
    } finally { await sidecar.handle.close(); }
  } catch (error) {
    if (source.created) await rm(savedTo, { force: true });
    throw error;
  } finally { await source.handle.close(); }
  return { ...downloaded, savedTo, manifestPath };
}

async function openDownloadTarget(file: string, overwrite: boolean) {
  if (!overwrite) return { handle: await open(file, 'wx', 0o600), created: true };
  try { return { handle: await open(file, 'r+'), created: false }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { handle: await open(file, 'wx', 0o600), created: true };
  }
}

async function directorySource(sourcePath?: string): Promise<boolean> {
  return sourcePath !== undefined && (await stat(path.resolve(sourcePath))).isDirectory();
}
async function uploadDirectory(api: CanvasApi, args: UploadArgs): Promise<FileUploadReceipt> {
  const packed = await packWebsiteWorkingCopy(path.resolve(args.sourcePath!));
  if (args.content !== undefined) throw new Error('Provide exactly one of content or sourcePath.');
  return api.request<FileUploadReceipt>('/file-uploads', 'POST', { ...args, sourcePath: undefined,
    content: packed.content, filename: args.filename ?? packed.filename, kind: args.kind ?? 'website',
    checkoutId: directoryCheckout(args, packed.manifest.checkoutId) });
}
function directoryCheckout(args: UploadArgs, checkoutId: string): string | undefined {
  return args.checkoutId ?? (args.mode === 'create' ? undefined : checkoutId);
}
