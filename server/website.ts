import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ApiError, CanvasStore } from './storage.js';

const run = promisify(execFile);
type SiteResponse = { body: Buffer; contentType: string; status: number };
type BuildCommand = { binary: string; args: string[] };
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function notice(title: string, detail: string): Buffer {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;padding:32px;color:#243244;background:#f7f9fc}main{max-width:600px;margin:auto}h1{font-size:22px}pre{white-space:pre-wrap}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`);
}

function htmlResponse(title: string, detail: string): SiteResponse {
  return { body: notice(title, detail), contentType: mime['.html'], status: 200 };
}

async function confinedSource(root: string, source: string): Promise<string> {
  if (!source || path.isAbsolute(source)) throw new ApiError(400, 'Website source must be a relative folder inside the data directory');
  const dataRoot = await realpath(root);
  let resolved: string;
  try { resolved = await realpath(path.resolve(root, source)); }
  catch { throw new ApiError(404, 'Website source folder was not found'); }
  if (!resolved.startsWith(`${dataRoot}${path.sep}`)) throw new ApiError(400, 'Website source must stay inside the data directory');
  if (!(await stat(resolved)).isDirectory()) throw new ApiError(400, 'Website source must be a folder');
  return resolved;
}

async function availableBinary(local: string, fallback: string): Promise<string> {
  return stat(local).then(() => local, () => fallback);
}

async function buildCommand(generator: string, source: string, output: string, basePath: string): Promise<BuildCommand> {
  if (generator === 'mkdocs') {
    const binary = await availableBinary(path.join(process.cwd(), '.venv', 'bin', 'mkdocs'), 'mkdocs');
    return { binary, args: ['build', '--config-file', path.join(source, 'mkdocs.yml'), '--site-dir', output] };
  }
  if (generator === 'hugo') return { binary: 'hugo', args: ['--source', source, '--destination', output, '--baseURL', basePath] };
  if (generator === 'docusaurus') {
    const binary = await availableBinary(path.join(source, 'node_modules', '.bin', 'docusaurus'), 'docusaurus');
    return { binary, args: ['build', source, '--out-dir', output] };
  }
  throw new ApiError(400, 'Use generator: mkdocs, hugo, or docusaurus');
}

function buildError(generator: string, error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const failure = error as NodeJS.ErrnoException & { stderr?: string };
  if (failure.code === 'ENOENT') return new ApiError(503, `${generator} is not installed on this server`);
  return new ApiError(502, `${generator} build failed: ${(failure.stderr || failure.message).slice(0, 500)}`);
}

async function buildSite(generator: string, source: string, output: string, basePath: string): Promise<void> {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  try {
    const { binary, args } = await buildCommand(generator, source, output, basePath);
    await run(binary, args, { timeout: 120_000, maxBuffer: 1_000_000 });
  } catch (error) {
    throw buildError(generator, error);
  }
}

async function websiteContent(store: CanvasStore, canvasId: string, blockId: string): Promise<string> {
  const canvas = await store.getCanvas(canvasId);
  const block = canvas.blocks.find(item => item.id === blockId);
  if (!block) throw new ApiError(404, 'Block not found');
  if (block.kind !== 'website') throw new ApiError(400, 'This block is not a website');
  return block.content;
}

function siteConfig(content: string): { generator: string; source: string } | null {
  const metadata = matter(content).data as Record<string, unknown>;
  const generator = metadata.generator;
  const source = metadata.source;
  if (typeof generator !== 'string' || typeof source !== 'string') return null;
  return { generator, source };
}

async function buildPreview(root: string, config: { generator: string; source: string }, output: string, basePath: string): Promise<SiteResponse | null> {
  try {
    const sourcePath = await confinedSource(root, config.source);
    await buildSite(config.generator, sourcePath, output, basePath);
    return null;
  } catch (error) {
    const message = String(error).replace(/^\w*Error: /, '');
    return htmlResponse('Website preview unavailable', message);
  }
}

function assetTarget(output: string, assetPath: string): string {
  const relative = assetPath.replace(/^\/+/, '') || 'index.html';
  const requested = path.resolve(output, relative);
  if (!requested.startsWith(`${output}${path.sep}`)) throw new ApiError(400, 'Invalid website asset path');
  return requested;
}

async function readAsset(output: string, file: string): Promise<Buffer> {
  try {
    const actual = await realpath(file);
    const canonicalOutput = await realpath(output);
    if (!actual.startsWith(`${canonicalOutput}${path.sep}`)) throw new ApiError(400, 'Invalid website asset path');
    return await readFile(actual);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Website asset not found');
    throw error;
  }
}

async function assetResponse(output: string, assetPath: string, staticPreview: boolean): Promise<SiteResponse> {
  const requested = assetTarget(output, assetPath);
  const file = (await stat(requested).then(info => info.isDirectory(), () => false)) ? path.join(requested, 'index.html') : requested;
  let body = await readAsset(output, file);
  if (staticPreview && path.extname(file) === '.html') {
    // Canvas previews are intentionally static; the full site link serves the original HTML.
    body = Buffer.from(body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ''));
  }
  return { body, contentType: mime[path.extname(file)] || 'application/octet-stream', status: 200 };
}

export async function siteResponse(store: CanvasStore, canvasId: string, blockId: string, assetPath: string, staticPreview = false): Promise<SiteResponse> {
  const config = siteConfig(await websiteContent(store, canvasId, blockId));
  if (!config) return htmlResponse('Website setup needed', 'Add generator: mkdocs, hugo, or docusaurus and source: sites/your-site to this block’s Markdown frontmatter.');
  const output = path.join(store.root, 'site-cache', canvasId, blockId);
  if (!assetPath || assetPath === '/') {
    const unavailable = await buildPreview(store.root, config, output, `/api/canvases/${canvasId}/blocks/${blockId}/site/`);
    if (unavailable) return unavailable;
  }
  return assetResponse(output, assetPath, staticPreview);
}
