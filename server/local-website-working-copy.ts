import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadedFile, WorkingCopyManifest } from '../shared/working-copy.js';
import { parseWebsite, readWebsiteDirectory } from './website-working-copy.js';

export const websiteManifestName = '.symbi.json';
export const websiteDocumentName = '.symbi-document.md';
export const websiteSourceName = 'source';

async function realDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  if (!(await lstat(resolved)).isDirectory()) {
    throw new Error('Website working copies require a real directory without symbolic links.');
  }
  return realpath(resolved);
}

async function writeProject(stage: string, downloaded: DownloadedFile): Promise<void> {
  const bundle = parseWebsite(downloaded.content);
  await mkdir(path.join(stage, websiteSourceName), { recursive: true });
  await writeFile(path.join(stage, websiteManifestName), JSON.stringify(downloaded.manifest, null, 2), { mode: 0o600 });
  await writeFile(path.join(stage, websiteDocumentName), bundle.documentContent);
  for (const file of bundle.files) {
    const target = path.join(stage, websiteSourceName, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
  }
}

async function reserveTarget(directory: string, backup: string, overwrite: boolean): Promise<boolean> {
  if (!overwrite) { await mkdir(directory); return false; }
  try {
    await realDirectory(directory);
    await rename(directory, backup);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory);
    return false;
  }
}

/** Expand package transport bytes into genuine project files for native editors. */
export async function unpackWebsiteWorkingCopy(directory: string, downloaded: DownloadedFile, overwrite = false) {
  const requested = path.resolve(directory);
  await mkdir(path.dirname(requested), { recursive: true });
  const parent = await realDirectory(path.dirname(requested));
  const resolved = path.join(parent, path.basename(requested));
  const stage = `${resolved}.download-${randomUUID()}`;
  const backup = `${stage}.backup`;
  await mkdir(stage);
  let reserved = false;
  let backedUp = false;
  try {
    await writeProject(stage, downloaded);
    backedUp = await reserveTarget(resolved, backup, overwrite);
    reserved = true;
    await rename(stage, resolved);
  } catch (error) {
    if (reserved) await rm(resolved, { recursive: true, force: true });
    if (backedUp) await rename(backup, resolved);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
  await rm(backup, { recursive: true, force: true });
  return { savedTo: resolved, manifestPath: path.join(resolved, websiteManifestName),
    documentPath: path.join(resolved, websiteDocumentName), sourceDirectory: path.join(resolved, websiteSourceName) };
}

/** Include added files and exclude removed files when repackaging the edited project. */
async function regularFile(file: string): Promise<string> {
  if (!(await lstat(file)).isFile()) throw new Error('Website working-copy control files must be regular files without symbolic links.');
  return readFile(file, 'utf8');
}

export async function packWebsiteWorkingCopy(directory: string) {
  const folder = await realDirectory(directory);
  const manifest = JSON.parse(await regularFile(path.join(folder, websiteManifestName))) as WorkingCopyManifest;
  if (manifest.kind !== 'website') throw new Error('The working-copy manifest does not describe a website project.');
  const documentContent = await regularFile(path.join(folder, websiteDocumentName));
  const files = await readWebsiteDirectory(await realDirectory(path.join(folder, websiteSourceName)));
  const content = JSON.stringify({ format: 'symbi-website', version: 1, documentContent, files }, null, 2);
  parseWebsite(content);
  if (Buffer.byteLength(content) > 999_900) throw new Error('The website working copy exceeds the 999900-byte transport limit.');
  return { content, manifest, filename: manifest.filename };
}
