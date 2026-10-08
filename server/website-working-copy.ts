import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { atomicJson } from './storage-files.js';
import { ApiError } from './errors.js';
import type { CanvasStore } from './storage.js';

export type WebsiteFile = { path: string; encoding: 'utf8' | 'base64'; content: string };
export type WebsitePackage = { format: 'symbi-website'; version: 1; documentContent: string; files: WebsiteFile[] };
const maxBytes = 999_900;
function sourceFolder(content: string): string {
  const source = matter(content).data.source as unknown;
  if (typeof source !== 'string' || !source || path.isAbsolute(source) || source.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) {
    throw new ApiError(400, 'Website source must be a relative folder inside the data directory');
  }
  if (!source.startsWith('sites/')) throw new ApiError(400, 'Editable website source must be inside sites/');
  return source;
}
async function confinedFolder(store: CanvasStore, content: string): Promise<string> {
  const root = await realpath(store.root);
  const file = path.resolve(root, sourceFolder(content));
  let actual: string;
  try { actual = await realpath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Website source folder was not found'); throw error; }
  if (!actual.startsWith(root + path.sep) || actual !== file || !(await lstat(actual)).isDirectory()) throw new ApiError(400, 'Website source must be a real folder inside sites/');
  return actual;
}
function validPackagePath(relative: string): void {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new ApiError(400, 'Website package paths must be safe relative file paths');
  }
}
function packageSize(files: WebsiteFile[]): void {
  if (files.length > 500 || Buffer.byteLength(JSON.stringify(files)) > maxBytes) throw new ApiError(413, 'Website package exceeds the 500-file or 999900-byte limit');
}
async function packageFile(folder: string, name: string): Promise<WebsiteFile> {
  const buffer = await readFile(path.join(folder, name));
  const utf8 = buffer.toString('utf8');
  const text = Buffer.from(utf8).equals(buffer) && !utf8.includes('\0');
  return { path: name, encoding: text ? 'utf8' : 'base64', content: text ? utf8 : buffer.toString('base64') };
}
async function readEntry(folder: string, name: string, entry: import('node:fs').Dirent, files: WebsiteFile[]): Promise<void> {
  if (entry.isSymbolicLink()) throw new ApiError(400, 'Website packages cannot contain symbolic links: ' + name);
  if (entry.isDirectory()) { await readFolder(folder, name, files); return; }
  if (!entry.isFile()) throw new ApiError(400, 'Website packages require regular files: ' + name);
  files.push(await packageFile(folder, name));
  packageSize(files);
}
async function readFolder(folder: string, relative = '', files: WebsiteFile[] = []): Promise<WebsiteFile[]> {
  for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true })) {
    if (['node_modules', '.git', '.cache', 'dist', 'build'].includes(entry.name)) continue;
    const name = relative ? relative + '/' + entry.name : entry.name;
    await readEntry(folder, name, entry, files);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function packageHash(files: WebsiteFile[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
export async function exportWebsite(store: CanvasStore, documentContent: string): Promise<{ content: string; packageHash: string }> {
  const files = await readFolder(await confinedFolder(store, documentContent));
  const value: WebsitePackage = { format: 'symbi-website', version: 1, documentContent, files };
  const content = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(content) > maxBytes) throw new ApiError(413, 'Website package exceeds the 999900-byte limit');
  return { content, packageHash: packageHash(files) };
}
function requirePackageHeader(value: WebsitePackage): void {
  if (value.format !== 'symbi-website' || value.version !== 1 || typeof value.documentContent !== 'string') throw new ApiError(400, 'Invalid symbi-website package');
}
function parsedPackage(content: string): WebsitePackage {
  let value: WebsitePackage;
  try { value = JSON.parse(content) as WebsitePackage; }
  catch { throw new ApiError(400, 'Upload the downloaded symbi-website JSON package, including documentContent and files'); }
  if (!value) throw new ApiError(400, 'Invalid symbi-website package');
  requirePackageHeader(value);
  if (!Array.isArray(value.files) || value.files.length > 500) throw new ApiError(400, 'Invalid symbi-website package files');
  return value;
}
function validateFileFields(file: WebsiteFile): void {
  if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !['utf8', 'base64'].includes(file.encoding)) throw new ApiError(400, 'Invalid website package file');
}
function validateEncodedAsset(file: WebsiteFile): void {
  if (file.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new ApiError(400, 'Invalid website asset base64');
}
export function parseWebsite(content: string): WebsitePackage {
  const value = parsedPackage(content);
  const names = new Set<string>();
  for (const file of value.files) {
    validateFileFields(file);
    validPackagePath(file.path);
    if (names.has(file.path)) throw new ApiError(400, 'Duplicate website package path');
    validateEncodedAsset(file);
    names.add(file.path);
  }
  value.files.sort((a, b) => a.path.localeCompare(b.path));
  sourceFolder(value.documentContent);
  packageSize(value.files);
  return value;
}
async function prepareFiles(stage: string, files: WebsiteFile[]): Promise<void> {
  await mkdir(stage, { recursive: true });
  for (const file of files) {
    const target = path.join(stage, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
  }
}
async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
}
async function finishReplacement<T>(folder: string, backup: string, save: () => Promise<T>): Promise<T> {
  try {
    const result = await save();
    await rm(backup, { recursive: true, force: true });
    return result;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    await rename(backup, folder);
    throw error;
  }
}
async function resumeReplacement(folder: string, backup: string, bundle: WebsitePackage): Promise<boolean> {
  if (!await exists(backup)) return false;
  if (!await exists(folder)) { await rename(backup, folder); return false; }
  if (packageHash(await readFolder(folder)) !== packageHash(bundle.files)) throw new ApiError(409, 'Interrupted website upload has changed source files');
  return true;
}
async function restoreMissingFolder(folder: string, backup: string): Promise<void> {
  if (!await exists(folder) && await exists(backup)) await rename(backup, folder);
}
/** The deterministic backup allows a retry to finish an interrupted folder and document save. */
export async function replaceWebsite<T>(store: CanvasStore, before: string, bundle: WebsitePackage, expectedHash: string,
  save: () => Promise<T>, operationId: string = randomUUID()): Promise<T> {
  if (sourceFolder(before) !== sourceFolder(bundle.documentContent)) throw new ApiError(400, 'A website replacement cannot move its source folder');
  const folder = path.resolve(await realpath(store.root), sourceFolder(before));
  const stage = folder + '.upload-' + operationId;
  const backup = folder + '.backup-' + operationId;
  if (await resumeReplacement(folder, backup, bundle)) return finishReplacement(folder, backup, save);
  await confinedFolder(store, before);
  if (packageHash(await readFolder(folder)) !== expectedHash) throw new ApiError(409, 'Website source files changed since download; download and merge the package again');
  await rm(stage, { recursive: true, force: true });
  await prepareFiles(stage, bundle.files);
  await rename(folder, backup);
  try {
    await rename(stage, folder);
    return await finishReplacement(folder, backup, save);
  } catch (error) {
    await restoreMissingFolder(folder, backup);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function createdWebsiteSource(store: CanvasStore, bundle: WebsitePackage, folder: string): Promise<boolean> {
  if (!await exists(folder)) return false;
  const actual = await confinedFolder(store, bundle.documentContent);
  if (packageHash(await readFolder(actual)) !== packageHash(bundle.files)) throw new ApiError(409, 'Interrupted website creation has changed source files');
  return true;
}
async function confinedParent(folder: string): Promise<void> {
  await mkdir(path.dirname(folder), { recursive: true });
  if ((await realpath(path.dirname(folder))) !== path.dirname(folder)) throw new ApiError(400, 'Website source cannot traverse a symbolic link');
}
async function prepareWebsiteCreation(store: CanvasStore, bundle: WebsitePackage, folder: string, marker: string): Promise<void> {
  if (await exists(folder)) throw new ApiError(409, 'Website source already exists; choose a new sites/ source folder for creation');
  await confinedParent(folder);
  await atomicJson(marker, { source: sourceFolder(bundle.documentContent), packageHash: packageHash(bundle.files) }, 0o600);
}
async function creationMarker(file: string): Promise<boolean> {
  try { await readFile(file, 'utf8'); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Persist the creation intent before placing source files, so interrupted creation is retryable. */
export async function createWebsite<T>(store: CanvasStore, bundle: WebsitePackage, operationId: string, save: () => Promise<T>): Promise<T> {
  const root = await realpath(store.root);
  const folder = path.resolve(root, sourceFolder(bundle.documentContent));
  const marker = path.join(root, 'file-package-creates', operationId + '.json');
  if (await creationMarker(marker)) {
    if (await createdWebsiteSource(store, bundle, folder)) return save();
  } else await prepareWebsiteCreation(store, bundle, folder, marker);
  await confinedParent(folder);
  const stage = folder + '.upload-' + operationId;
  await rm(stage, { recursive: true, force: true });
  await prepareFiles(stage, bundle.files);
  await rename(stage, folder);
  return save();
}

export async function readWebsiteDirectory(folder: string): Promise<WebsiteFile[]> {
  const actual = await realpath(folder);
  if (!(await lstat(actual)).isDirectory()) throw new ApiError(400, 'Website source must be a directory');
  return readFolder(actual);
}
