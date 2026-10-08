import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock } from '../shared/types';
import type { DownloadedFile } from '../shared/working-copy';

type Invoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;
/** The external coding agent edits a real local file; MCP only transfers bytes and manifests. */
export async function localBrowserUpload(invoke: Invoke, directory: string, args: Record<string, unknown>): Promise<CanvasBlock> {
  const blockId = args.blockId;
  const downloaded = typeof blockId === 'string' ? await invoke('download_file', { canvasId: args.canvasId, blockId }) as DownloadedFile : null;
  const folder = path.join(directory, '.browser-working-copies');
  await mkdir(folder, { recursive: true });
  const filename = String(args.filename ?? downloaded?.filename ?? 'notes.md');
  const file = path.join(folder, `${randomUUID()}-${path.basename(filename)}`);
  if (downloaded) await writeFile(file, downloaded.content);
  await writeFile(file, String(args.content));
  const { blockId: _blockId, ...input } = args;
  void _blockId;
  const receipt = await invoke('upload_file', { ...input, mode: downloaded ? 'replace' : 'create',
    canvasId: args.canvasId, filename, checkoutId: downloaded?.manifest.checkoutId,
    content: await readFile(file, 'utf8'), idempotencyKey: randomUUID() }) as { blockId: string };
  return await invoke('read_doc', { canvasId: args.canvasId, blockId: receipt.blockId }) as CanvasBlock;
}
