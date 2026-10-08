import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadedFile } from '../shared/working-copy.js';
import { packWebsiteWorkingCopy, unpackWebsiteWorkingCopy } from './local-website-working-copy.js';

/** Persistent local files belong to a conversation, never to the shared document store. */
export async function conversationWorkspace(root: string, conversationId: string): Promise<string> {
  const key = createHash('sha256').update(conversationId).digest('hex');
  const directory = path.join(root, '.agent-workspaces', key);
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

export async function workspacePath(root: string, requested: string): Promise<string> {
  const relative = requested.replace(/^\/+/, '');
  if (!relative || relative.split(/[\\/]/u).some(segment => segment === '..')) throw new Error('A working file path inside the conversation workspace is required.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('The file path is outside the conversation workspace.');
  await checkWorkspaceAncestors(root, target);
  return target;
}

async function checkWorkspaceAncestors(root: string, target: string): Promise<void> {
  let existing = target;
  while (existing !== root) {
    try {
      const entry = await lstat(existing);
      if (entry.isSymbolicLink()) throw new Error('Working file paths cannot follow symbolic links.');
      existing = path.dirname(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = path.dirname(existing);
    }
  }
}

async function materializeWebsite(root: string, output: Record<string, unknown>, manifest: Record<string, unknown>, destination: string | undefined, overwrite: boolean) {
  const directory = await workspacePath(root, destination ?? `${manifest.checkoutId}/project`);
  const expanded = await unpackWebsiteWorkingCopy(directory, output as unknown as DownloadedFile, overwrite);
  const virtual = (file: string) => `/${path.relative(root, file)}`;
  return { ...output, savedTo: virtual(expanded.savedTo), manifestPath: virtual(expanded.manifestPath),
    documentPath: virtual(expanded.documentPath), sourceDirectory: virtual(expanded.sourceDirectory) };
}

async function writeDownloadedFile(target: string, sidecarPath: string, output: Record<string, unknown>, manifest: Record<string, unknown>, overwrite: boolean): Promise<void> {
  const source = await open(target, overwrite ? 'a+' : 'wx');
  try {
    let sidecar;
    try { sidecar = await open(sidecarPath, overwrite ? 'a+' : 'wx', 0o600); }
    catch (error) {
      // This newly reserved source is empty; preserve any existing edited file.
      if (!overwrite) await rm(target);
      throw error;
    }
    try {
      await source.truncate(0);
      await sidecar.truncate(0);
      await source.writeFile(output.content as string);
      await sidecar.writeFile(JSON.stringify(manifest, null, 2));
    } finally { await sidecar.close(); }
  } finally { await source.close(); }
}

export async function materializeDownload(root: string, output: Record<string, unknown>, destination?: string, overwrite = false) {
  const manifest = output.manifest as Record<string, unknown> | undefined;
  if (!manifest || typeof output.content !== 'string') return output;
  const name = `${manifest.checkoutId}/${path.basename(String(manifest.filename ?? output.filename))}`;
  if (manifest.kind === 'website') return materializeWebsite(root, output, manifest, destination, overwrite);
  const target = await workspacePath(root, destination ?? name);
  await mkdir(path.dirname(target), { recursive: true });
  const sidecarPath = await workspacePath(root, `${path.relative(root, target)}.symbi.json`);
  await writeDownloadedFile(target, sidecarPath, output, manifest, overwrite);
  return { ...output, savedTo: `/${path.relative(root, target)}`, manifestPath: `/${path.relative(root, target)}.symbi.json` };
}

function checkUploadEntry(entry: Stats): void {
  if (!entry.isDirectory() && !entry.isFile()) throw new Error('Upload requires a regular working file or an expanded website directory.');
  if (!entry.isDirectory() && entry.size > 3_999_600) throw new Error('The working file exceeds the upload size limit.');
}

async function uploadSidecar(root: string, target: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(await workspacePath(root, `${path.relative(root, target)}.symbi.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {};
}

async function uploadSource(root: string, target: string): Promise<{ content: string; manifest: Record<string, unknown> }> {
  const entry = await lstat(target); checkUploadEntry(entry);
  if (entry.isDirectory()) {
    const project = await packWebsiteWorkingCopy(target);
    return { content: project.content, manifest: { ...project.manifest } };
  }
  const content = await readFile(target, 'utf8');
  return { content, manifest: await uploadSidecar(root, target) };
}

function uploadIdentity(args: Record<string, unknown>, manifest: Record<string, unknown>, defaultCanvasId?: string) {
  const defaults = args.mode === 'create' ? { canvasId: defaultCanvasId, checkoutId: undefined }
    : { canvasId: manifest.canvasId ?? defaultCanvasId, checkoutId: manifest.checkoutId };
  return { canvasId: args.canvasId ?? defaults.canvasId, checkoutId: args.checkoutId ?? defaults.checkoutId };
}

function uploadMetadata(args: Record<string, unknown>, manifest: Record<string, unknown>, target: string) {
  return { mode: args.mode ?? 'replace', filename: args.filename ?? manifest.filename ?? path.basename(target), kind: args.kind ?? manifest.kind };
}

function uploadRequest(args: Record<string, unknown>, target: string, content: string, manifest: Record<string, unknown>,
  defaultCanvasId?: string): Record<string, unknown> {
  const input = { ...args };
  delete input.sourcePath;
  if (args.mode === undefined && !manifest.checkoutId) throw new Error('A new local file requires explicit mode=create. Download an existing document before replacing it.');
  const identity = uploadIdentity(args, manifest, defaultCanvasId);
  const metadata = uploadMetadata(args, manifest, target);
  return { ...input, ...identity, ...metadata, content,
    idempotencyKey: args.idempotencyKey ?? createHash('sha256').update(JSON.stringify([manifest.checkoutId, identity.canvasId, target, metadata.mode, content])).digest('hex') };
}

export async function workingUpload(root: string, args: Record<string, unknown>, defaultCanvasId?: string): Promise<Record<string, unknown>> {
  if (typeof args.sourcePath !== 'string') throw new Error('Upload requires sourcePath: edit a local working file before uploading it.');
  if (args.content !== undefined) throw new Error('Upload a working file with sourcePath; do not provide replacement content directly.');
  const target = await workspacePath(root, args.sourcePath);
  const { content, manifest } = await uploadSource(root, target);
  return uploadRequest(args, target, content, manifest, defaultCanvasId);
}

export async function workingManifest(root: string, sourcePath: string): Promise<Record<string, unknown> | null> {
  const target = await workspacePath(root, sourcePath);
  const manifestPath = (await lstat(target)).isDirectory() ? path.join(target, '.symbi.json') : `${target}.symbi.json`;
  try { return JSON.parse(await readFile(await workspacePath(root, path.relative(root, manifestPath)), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
