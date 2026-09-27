import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BlockKind, CanvasBlock, CanvasDocument, CanvasTask, ChatSettings, CrossLink, DocumentGroup, DocumentLock, LinkRelation, SearchHit, WorkspaceSummary } from '../shared/types.js';
import { validGroupKey } from '../shared/groups.js';
import { documentText } from '../shared/document-text.js';
import { loaderFor } from '../shared/file-transfer.js';
import { DocumentVersions } from './version-control.js';
import { ApiError } from './errors.js';
import { claimedTask, commentedTask, DocumentLocks, newTask, patchedTask } from './coordination.js';
import { safeEqual, hashToken } from './auth.js';
import { getSimilarityIndex, type SimilarityIndex } from './similarity.js';
import { defaultPrivateSettings, jevKey, newMcpToken, providerKey, publicSettings, updatedSettings, type PrivateSettings } from './settings.js';

export { ApiError };

type StoredBlock = Omit<CanvasBlock, 'content' | 'contentHash' | 'lock'>;
type StoredCanvas = Omit<CanvasDocument, 'blocks'> & { blocks: StoredBlock[] };
type MergeJournal = { mergeId: string; canvasId: string; keepBlockId: string; beforeCanvas: StoredCanvas;
  afterCanvas: StoredCanvas; beforeTasks: CanvasTask[]; afterTasks: CanvasTask[];
  beforeContent: string; afterContent: string;
  otherCanvases: { id: string; before: StoredCanvas; after: StoredCanvas }[]; undone?: boolean };

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const kinds: BlockKind[] = ['markdown', 'slides', 'website', 'mdx'];
const linkRelations = new Set<LinkRelation>(['prerequisite', 'implements', 'decision_for', 'supersedes',
  'contradicts', 'example_of', 'same_topic', 'related']);
const contentCacheLimit = 16 * 1024 * 1024;

function fileSignature(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function storedBlock(block: CanvasBlock): StoredBlock {
  return {
    id: block.id, title: block.title, file: block.file, kind: block.kind,
    x: block.x, y: block.y, width: block.width, height: block.height, links: block.links,
    purpose: block.purpose, reviewer: block.reviewer, group: block.group, workArea: block.workArea, tags: block.tags,
    linkTypes: block.linkTypes, crossLinks: block.crossLinks, quality: block.quality, archived: block.archived, stale: block.stale,
  };
}

function optionalLabel(value: unknown, field: string, previous: string | undefined): string | undefined {
  if (value === undefined) return previous;
  if (typeof value !== 'string' || value.length > 80) throw new ApiError(400, `${field} must be a string of at most 80 characters`);
  return value.trim() || undefined;
}

function optionalGroup(value: unknown, previous: DocumentGroup | undefined): DocumentGroup | undefined {
  if (value === undefined) return previous;
  if (value === null || value === '') return undefined;
  if (!validGroupKey(value)) throw new ApiError(400, 'group must be a lane:, area:, purpose:, or custom: key with up to eight path segments');
  return value;
}

function optionalTags(value: unknown, previous: string[] | undefined): string[] | undefined {
  if (value === undefined) return previous;
  if (!Array.isArray(value) || value.length > 20 || value.some(tag =>
    typeof tag !== 'string' || !tag.trim() || tag.trim().length > 40 || /[\x00-\x1f\x7f]/.test(tag))) {
    throw new ApiError(400, 'tags must be an array of at most 20 nonempty labels, each at most 40 characters');
  }
  const unique = new Map<string, string>();
  for (const tag of value as string[]) {
    const trimmed = tag.trim();
    if (!unique.has(trimmed.toLocaleLowerCase())) unique.set(trimmed.toLocaleLowerCase(), trimmed);
  }
  return [...unique.values()];
}

function optionalLinkTypes(value: unknown, previous: Record<string, LinkRelation> | undefined, links: string[]): Record<string, LinkRelation> | undefined {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new ApiError(400, 'linkTypes must be an object');
  const entries = Object.entries((value ?? previous ?? {}) as Record<string, unknown>)
    .filter(([id]) => value !== undefined || links.includes(id));
  if (entries.length > 100 || entries.some(([id, relation]) => !links.includes(id) || !linkRelations.has(relation as LinkRelation))) {
    throw new ApiError(400, 'linkTypes must name saved links and supported relations');
  }
  return entries.length ? Object.fromEntries(entries) as Record<string, LinkRelation> : undefined;
}

function optionalCrossLinks(value: unknown, previous: CrossLink[] | undefined): CrossLink[] | undefined {
  if (value === undefined) return previous;
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'crossLinks must contain at most 20 links');
  const seen = new Set<string>();
  const links: CrossLink[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ApiError(400, 'Invalid cross link');
    const link = candidate as Record<string, unknown>;
    if (typeof link.canvasId !== 'string' || !validId(link.canvasId) || typeof link.blockId !== 'string' || !validId(link.blockId)
      || (link.relation !== undefined && !linkRelations.has(link.relation as LinkRelation))
      || (link.confidence !== undefined && (typeof link.confidence !== 'number' || !Number.isFinite(link.confidence)
        || link.confidence < 0 || link.confidence > 1))) throw new ApiError(400, 'Invalid cross link');
    const key = `${link.canvasId}:${link.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ canvasId: link.canvasId, blockId: link.blockId,
      ...(link.relation ? { relation: link.relation as LinkRelation } : {}),
      ...(link.confidence !== undefined ? { confidence: link.confidence as number } : {}) });
  }
  return links.length ? links : undefined;
}

function optionalQuality(value: unknown, previous: CanvasBlock['quality']): CanvasBlock['quality'] {
  if (value === undefined) return previous;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid quality score');
  const score = (value as Record<string, unknown>).score;
  const at = (value as Record<string, unknown>).at;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1
    || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new ApiError(400, 'Invalid quality score');
  return { score, at };
}

function optionalBoolean(value: unknown, previous: boolean | undefined, field: string): boolean | undefined {
  if (value === undefined) return previous;
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be a boolean`);
  return value;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function validId(id: string): boolean {
  return idPattern.test(id);
}

function requiredText(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ApiError(400, `${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

function contentText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_000_000) {
    throw new ApiError(400, 'content must be a string of at most 1 MB');
  }
  return value;
}

function coordinate(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new ApiError(400, `${field} must be a finite number within 1,000,000`);
  }
  return value;
}

function dimension(value: unknown, field: string, fallback: number): number {
  const number = coordinate(value, field, fallback);
  if (number < 100 || number > 5000) throw new ApiError(400, `${field} must be between 100 and 5000`);
  return number;
}

function freeBlockPosition(blocks: CanvasBlock[], origin: { x: number; y: number }): { x: number; y: number } {
  const width = 400;
  const height = 320;
  const gap = 32;
  for (let index = 0; index < (blocks.length + 1) * 100; index++) {
    const horizontal = (index % 6) * (width + gap);
    const vertical = Math.floor(index / 6) * (height + gap);
    const x = origin.x + horizontal > 1_000_000 ? origin.x - horizontal : origin.x + horizontal;
    const y = origin.y + vertical > 1_000_000 ? origin.y - vertical : origin.y + vertical;
    if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) continue;
    const collides = blocks.some(block => x < block.x + block.width + gap && x + width + gap > block.x &&
      y < block.y + block.height + gap && y + height + gap > block.y);
    if (!collides) return { x, y };
  }
  throw new ApiError(409, 'No free position is available near the requested coordinates');
}

function blockKind(value: unknown): BlockKind {
  if (value === undefined) return 'markdown';
  if (!kinds.includes(value as BlockKind)) throw new ApiError(400, 'Unsupported block kind');
  return value as BlockKind;
}

function searchExcerpt(text: string, matchAt: number, matchLength: number): string {
  const width = Math.max(180, matchLength);
  const start = Math.max(0, Math.min(matchAt - Math.floor((width - matchLength) / 2), text.length - width));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function validLinks(links: unknown, blockId: string, blocks: CanvasBlock[]): links is string[] {
  return Array.isArray(links) && links.every(link =>
    typeof link === 'string' && validId(link) && link !== blockId && blocks.some(block => block.id === link));
}

function updatedBlock(previous: CanvasBlock, input: Record<string, unknown>, blocks: CanvasBlock[]): CanvasBlock {
  const links = input.links === undefined ? previous.links : input.links;
  if (!validLinks(links, previous.id, blocks)) {
    throw new ApiError(400, 'links must contain existing block IDs on this canvas');
  }
  return {
    ...previous,
    title: input.title === undefined ? previous.title : requiredText(input.title, 'title'),
    ...(() => {
      const content = input.content === undefined ? previous.content : contentText(input.content);
      return { content, kind: loaderFor(input.kind === undefined ? previous.kind : blockKind(input.kind), content) };
    })(),
    x: coordinate(input.x, 'x', previous.x),
    y: coordinate(input.y, 'y', previous.y),
    width: dimension(input.width, 'width', previous.width),
    height: dimension(input.height, 'height', previous.height),
    links,
    linkTypes: optionalLinkTypes(input.linkTypes, previous.linkTypes, links),
    crossLinks: optionalCrossLinks(input.crossLinks, previous.crossLinks),
    quality: optionalQuality(input.quality, previous.quality),
    archived: optionalBoolean(input.archived, previous.archived, 'archived'),
    stale: optionalBoolean(input.stale, previous.stale, 'stale'),
    tags: optionalTags(input.tags, previous.tags),
    purpose: optionalLabel(input.purpose, 'purpose', previous.purpose),
    reviewer: optionalLabel(input.reviewer, 'reviewer', previous.reviewer),
    workArea: optionalLabel(input.workArea, 'workArea', previous.workArea),
    group: optionalGroup(input.group, previous.group),
  };
}

type BlockPosition = { blockId: string; x: number; y: number; group?: DocumentGroup | null };

function requiredCoordinate(value: unknown, field: string): number {
  if (value === undefined) throw new ApiError(400, `${field} is required`);
  return coordinate(value, field, 0);
}

function blockPosition(value: unknown): BlockPosition {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'Invalid layout position');
  const entry = value as Record<string, unknown>;
  if (typeof entry.blockId !== 'string' || !validId(entry.blockId)) throw new ApiError(400, 'Invalid layout block ID');
  return { blockId: entry.blockId, x: requiredCoordinate(entry.x, 'x'), y: requiredCoordinate(entry.y, 'y'),
    ...(entry.group === undefined ? {} : { group: entry.group === null ? null : optionalGroup(entry.group, undefined) ?? null }) };
}

function validPositions(value: unknown): BlockPosition[] {
  if (!Array.isArray(value) || value.length < 1) throw new ApiError(400, 'positions must contain at least one block');
  const positions = value.map(blockPosition);
  if (new Set(positions.map(item => item.blockId)).size !== positions.length) throw new ApiError(400, 'Layout contains duplicate blocks');
  return positions;
}

async function atomicJson(file: string, value: unknown, mode = 0o644): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode });
    await rename(temporary, file);
    await chmod(file, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

type ContentChange = { expectedContentHash?: unknown };

function checkExpectedHash(input: ContentChange, current: string): void {
  if (input.expectedContentHash === undefined) return;
  if (typeof input.expectedContentHash !== 'string' || input.expectedContentHash !== contentHash(current)) {
    throw new ApiError(409, 'This document changed since you read it. Read it again and reapply your edit.');
  }
}

function protectedChange(input: Record<string, unknown>): boolean {
  return input.content !== undefined || input.title !== undefined || input.kind !== undefined;
}

export class CanvasStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly documentMetadataCache = new Map<string, { contentHash: string; lastModified?: string; authors: string[]; latestAuthor?: string }>();
  private readonly contentCache = new Map<string, { signature: string; content: string; bytes: number }>();
  private contentCacheBytes = 0;
  private readonly searchBodyCache = new Map<string, string>();
  private searchBodyCacheBytes = 0;
  readonly locks = new DocumentLocks();

  constructor(public readonly root: string) {}

  private workspacesFile(): string { return path.join(this.root, 'workspaces.json'); }
  private canvasFile(id: string): string { return path.join(this.root, 'canvases', `${id}.json`); }
  private tasksFile(id: string): string { return path.join(this.root, 'tasks', `${id}.json`); }
  private settingsFile(): string { return path.join(this.root, 'settings.json'); }
  private mergeFile(id: string): string { return path.join(this.root, 'jev-merges', `${id}.json`); }
  private docFile(file: string): string { return path.join(this.root, file); }
  private versionFile(blockId: string): DocumentVersions { return new DocumentVersions(path.join(this.root, '.versions', blockId)); }
  jevCacheFile(canvasId: string): string { return path.join(this.root, 'jev-cache', `${canvasId}.json`); }
  similarityIndex(workspaceId: string): SimilarityIndex { return getSimilarityIndex(`${this.root}:${workspaceId}`); }

  async documentMetadata(block: CanvasBlock): Promise<{ lastModified?: string; authors: string[]; latestAuthor?: string }> {
    const hash = block.contentHash ?? contentHash(block.content);
    const cached = this.documentMetadataCache.get(block.id);
    if (cached?.contentHash === hash) return cached;
    const versions = this.versionFile(block.id);
    await versions.init(block.content);
    const status = await versions.status();
    const authors = [...new Set(status.commits.map(commit => commit.author))].slice(0, 3);
    const metadata = { contentHash: hash, lastModified: status.commits[0]?.createdAt,
      authors, latestAuthor: status.commits[0]?.author };
    this.documentMetadataCache.set(block.id, metadata);
    return metadata;
  }

  private async existingCrossLinks(workspaceId: string, sourceCanvasId: string, links: CrossLink[],
    canvases = new Map<string, Promise<StoredCanvas | undefined>>()): Promise<CrossLink[]> {
    const valid: CrossLink[] = [];
    for (const link of links) {
      if (link.canvasId === sourceCanvasId) continue;
      if (!canvases.has(link.canvasId)) {
        canvases.set(link.canvasId, this.readJson<StoredCanvas>(this.canvasFile(link.canvasId)).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }));
      }
      const target = await canvases.get(link.canvasId);
      if (target?.workspaceId === workspaceId && target.blocks.some(block => block.id === link.blockId && !block.archived)) valid.push(link);
    }
    return valid;
  }

  private async readDocument(file: string): Promise<string> {
    const fullPath = this.docFile(file);
    const signature = fileSignature(await stat(fullPath, { bigint: true }));
    const cached = this.contentCache.get(fullPath);
    if (cached?.signature === signature) {
      this.contentCache.delete(fullPath);
      this.contentCache.set(fullPath, cached);
      return cached.content;
    }
    const content = await readFile(fullPath, 'utf8');
    if (cached) {
      this.contentCache.delete(fullPath);
      this.contentCacheBytes -= cached.bytes;
    }
    const bytes = Buffer.byteLength(content);
    if (bytes <= contentCacheLimit) {
      this.contentCache.set(fullPath, { signature, content, bytes });
      this.contentCacheBytes += bytes;
      while (this.contentCacheBytes > contentCacheLimit) {
        const oldest = this.contentCache.keys().next().value;
        if (!oldest) break;
        this.contentCacheBytes -= this.contentCache.get(oldest)!.bytes;
        this.contentCache.delete(oldest);
      }
    }
    return content;
  }

  private searchableBody(block: CanvasBlock): string {
    const hash = block.contentHash ?? contentHash(block.content);
    const cached = this.searchBodyCache.get(hash);
    if (cached !== undefined) {
      this.searchBodyCache.delete(hash);
      this.searchBodyCache.set(hash, cached);
      return cached;
    }
    const body = documentText(block.content).replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim();
    const bytes = Buffer.byteLength(body);
    if (bytes <= contentCacheLimit / 2) {
      this.searchBodyCache.set(hash, body);
      this.searchBodyCacheBytes += bytes;
      while (this.searchBodyCacheBytes > contentCacheLimit / 2) {
        const oldest = this.searchBodyCache.keys().next().value;
        if (!oldest) break;
        this.searchBodyCacheBytes -= Buffer.byteLength(this.searchBodyCache.get(oldest)!);
        this.searchBodyCache.delete(oldest);
      }
    }
    return body;
  }

  private async readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'docs'), { recursive: true });
    await mkdir(path.join(this.root, 'canvases'), { recursive: true });
    try {
      await readFile(this.workspacesFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.seed();
    }
  }

  private async seed(): Promise<void> {
    const workspace: WorkspaceSummary = {
      id: 'acme-team', name: 'Acme Team', canvases: [{ id: 'product-roadmap', name: 'Product Roadmap' }],
    };
    const samples: Array<Pick<CanvasBlock, 'id' | 'title' | 'kind' | 'content' | 'x' | 'y' | 'width' | 'height' | 'links'>> = [
      { id: 'roadmap-overview', title: 'Roadmap overview', kind: 'markdown', x: 60, y: 70, width: 420, height: 340, links: ['launch-flow'], content: '# Product Roadmap\n\nOur shared launch plan lives on this canvas. Move the cards, follow their links, or ask the agent to update a document.\n\n| Milestone | Owner | Status |\n| --- | --- | --- |\n| Discovery | Product | Done |\n| Beta | Engineering | In progress |\n| Launch | Team | Planned |\n' },
      { id: 'launch-flow', title: 'Launch flow', kind: 'markdown', x: 580, y: 80, width: 460, height: 350, links: ['launch-checklist'], content: '# Launch flow\n\n```mermaid\nflowchart LR\n  Idea --> Design --> Build --> Beta --> Launch\n```\n' },
      { id: 'launch-checklist', title: 'Launch checklist', kind: 'markdown', x: 600, y: 520, width: 420, height: 320, links: [], content: '# Launch checklist\n\n- [x] Agree on scope\n- [ ] Test beta with customers\n- [ ] Publish release notes\n- [ ] Announce launch\n' },
      { id: 'pitch-slides', title: 'Pitch slides', kind: 'slides', x: -420, y: 120, width: 380, height: 300, links: ['roadmap-overview'], content: '# Acme Team\n\nOne workspace for the whole launch.\n\n---\n\n# From idea to launch\n\n- Plan on an infinite canvas\n- Keep every block as Markdown\n- Work with the chat agent\n' },
      { id: 'team-docs', title: 'Team docs site', kind: 'website', x: 1100, y: 100, width: 430, height: 320, links: [], content: '---\ngenerator: mkdocs\nsource: sites/team-docs\n---\n\n# Team docs\n\nBuild this folder into a documentation website.\n' },
    ];
    const canvas: StoredCanvas = {
      id: 'product-roadmap', name: 'Product Roadmap', workspaceId: workspace.id,
      blocks: samples.map(sample => storedBlock({ ...sample, file: `docs/${sample.id}.md` })),
    };
    for (const sample of samples) await writeFile(this.docFile(`docs/${sample.id}.md`), sample.content);
    await mkdir(path.join(this.root, 'sites', 'team-docs', 'docs'), { recursive: true });
    await writeFile(path.join(this.root, 'sites', 'team-docs', 'mkdocs.yml'), 'site_name: Acme Team Docs\n');
    await writeFile(path.join(this.root, 'sites', 'team-docs', 'docs', 'index.md'), '# Acme Team Docs\n\nWelcome to our team documentation.\n');
    await atomicJson(this.canvasFile(canvas.id), canvas);
    await atomicJson(this.workspacesFile(), [workspace]);
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.readJson<WorkspaceSummary[]>(this.workspacesFile());
  }

  async createWorkspace(input: Record<string, unknown>): Promise<WorkspaceSummary> {
    const name = requiredText(input.name, 'name');
    return this.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = { id: randomUUID(), name, canvases: [] };
      workspaces.push(workspace);
      await atomicJson(this.workspacesFile(), workspaces);
      return workspace;
    });
  }

  async getCanvas(id: string, includeArchived = false): Promise<CanvasDocument> {
    if (!validId(id)) throw new ApiError(400, 'Invalid canvas ID');
    let canvas: StoredCanvas;
    try { canvas = await this.readJson<StoredCanvas>(this.canvasFile(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Canvas not found');
      throw error;
    }
    const crossLinkCanvases = new Map<string, Promise<StoredCanvas | undefined>>();
    const blocks = await Promise.all(canvas.blocks.map(async block => {
      const content = await this.readDocument(block.file);
      const lock = this.locks.active(id, block.id);
      const crossLinks = block.crossLinks ? await this.existingCrossLinks(canvas.workspaceId, id, block.crossLinks, crossLinkCanvases) : undefined;
      return { ...block, content, contentHash: contentHash(content), ...(lock ? { lock } : {}),
        crossLinks: crossLinks?.length ? crossLinks : undefined };
    }));
    this.similarityIndex(canvas.workspaceId).syncCanvas(id, blocks.filter(block => !block.archived));
    return { ...canvas, blocks: includeArchived ? blocks : blocks.filter(block => !block.archived) };
  }

  async getCanvasRevision(id: string): Promise<string> {
    if (!validId(id)) throw new ApiError(400, 'Invalid canvas ID');
    let canvas: StoredCanvas;
    const canvasFile = this.canvasFile(id);
    try { canvas = await this.readJson<StoredCanvas>(canvasFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Canvas not found');
      throw error;
    }
    const linkedCanvases = [...new Set(canvas.blocks.flatMap(block => block.crossLinks?.map(link => link.canvasId) ?? []))]
      .filter(linkedId => linkedId !== id).sort();
    const files = [canvasFile, ...canvas.blocks.map(block => this.docFile(block.file)),
      ...linkedCanvases.map(linkedId => this.canvasFile(linkedId))];
    const signatures = await Promise.all(files.map(async (file, index) => {
      try { return `${index}:${fileSignature(await stat(file, { bigint: true }))}`; }
      catch (error) {
        if (index > canvas.blocks.length && (error as NodeJS.ErrnoException).code === 'ENOENT') return `${index}:missing`;
        throw error;
      }
    }));
    const locks = canvas.blocks.map(block => this.locks.active(id, block.id) ?? null);
    return `"${createHash('sha256').update(signatures.join('|')).update(JSON.stringify(locks)).digest('hex').slice(0, 24)}"`;
  }

  async createCanvas(workspaceId: string, input: Record<string, unknown>): Promise<CanvasDocument> {
    if (!validId(workspaceId)) throw new ApiError(400, 'Invalid workspace ID');
    const name = requiredText(input.name, 'name');
    return this.serialize(async () => {
      const workspaces = await this.listWorkspaces();
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new ApiError(404, 'Workspace not found');
      const canvas: StoredCanvas = { id: randomUUID(), name, workspaceId, blocks: [] };
      workspace.canvases.push({ id: canvas.id, name });
      await atomicJson(this.canvasFile(canvas.id), canvas);
      await atomicJson(this.workspacesFile(), workspaces);
      return { ...canvas, blocks: [] };
    });
  }

  async createBlock(canvasId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    const title = requiredText(input.title, 'title');
    const content = contentText(input.content ?? `# ${title}\n`);
    const kind = loaderFor(blockKind(input.kind), content);
    const origin = { x: coordinate(input.x, 'x', 100), y: coordinate(input.y, 'y', 100) };
    const group = optionalGroup(input.group, undefined);
    const tags = optionalTags(input.tags, undefined);
    return this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const id = randomUUID();
      const position = freeBlockPosition(canvas.blocks, origin);
      const block: CanvasBlock = { id, title, kind, content, ...position, width: 400, height: 320, links: [], file: `docs/${id}.md`, ...(group ? { group } : {}), ...(tags ? { tags } : {}) };
      await writeFile(this.docFile(block.file), content);
      await atomicJson(this.canvasFile(canvasId), { ...canvas, blocks: [...canvas.blocks, block].map(storedBlock) });
      const versions = this.versionFile(id);
      await versions.init('');
      await versions.commit(content, `Create ${title}`, actor);
      return { ...block, contentHash: contentHash(content) };
    });
  }

  async updateBlock(canvasId: string, blockId: string, input: Record<string, unknown>, actor = 'api'): Promise<CanvasBlock> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    return this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const previous = canvas.blocks.find(item => item.id === blockId);
      if (!previous) throw new ApiError(404, 'Block not found');
      if (protectedChange(input)) this.locks.check(canvasId, blockId, actor);
      checkExpectedHash(input, previous.content);
      const updated = updatedBlock(previous, input, canvas.blocks);
      if (input.crossLinks !== undefined && (await this.existingCrossLinks(canvas.workspaceId, canvasId, updated.crossLinks ?? [])).length
        !== (updated.crossLinks ?? []).length) throw new ApiError(400, 'Cross links must target existing documents in this workspace');
      if (input.content !== undefined && updated.content !== previous.content) {
        const versions = this.versionFile(blockId);
        await versions.init(previous.content);
        await versions.commit(updated.content, typeof input.message === 'string' && input.message.trim() ? input.message.trim() : `Edit ${updated.title}`, actor);
        await writeFile(this.docFile(previous.file), updated.content);
      }
      await atomicJson(this.canvasFile(canvasId), { ...canvas, blocks: canvas.blocks.map(block => block.id === blockId ? updated : block).map(storedBlock) });
      const lock = this.locks.active(canvasId, blockId);
      const result: CanvasBlock = { ...updated, contentHash: contentHash(updated.content) };
      if (lock) result.lock = lock; else delete result.lock;
      return result;
    });
  }

  async mergeDocuments(canvasId: string, input: Record<string, unknown>, actor = 'api'):
    Promise<{ mergeId: string; keepBlockId: string; archivedBlockIds: string[]; contentHash: string }> {
    const keepBlockId = input.keepBlockId;
    const mergeBlockIds = input.mergeBlockIds;
    const hashes = input.expectedContentHashes;
    const content = contentText(input.content);
    if (typeof keepBlockId !== 'string' || !validId(keepBlockId) || !Array.isArray(mergeBlockIds)
      || !mergeBlockIds.length || mergeBlockIds.length > 10 || mergeBlockIds.some(id => typeof id !== 'string' || !validId(id) || id === keepBlockId)
      || new Set(mergeBlockIds).size !== mergeBlockIds.length || !hashes || typeof hashes !== 'object' || Array.isArray(hashes)) {
      throw new ApiError(400, 'Merge requires a keeper, distinct documents, and expected content hashes');
    }
    return this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const beforeCanvas = await this.readJson<StoredCanvas>(this.canvasFile(canvasId));
      const byId = new Map(canvas.blocks.map(block => [block.id, block]));
      const keeper = byId.get(keepBlockId);
      const merging = (mergeBlockIds as string[]).map(id => byId.get(id));
      if (!keeper || keeper.archived || merging.some(block => !block || block.archived)) throw new ApiError(404, 'A merge document no longer exists');
      for (const block of [keeper, ...merging] as CanvasBlock[]) {
        this.locks.check(canvasId, block.id, actor);
        if ((hashes as Record<string, unknown>)[block.id] !== contentHash(block.content)) {
          throw new ApiError(409, 'A merge document changed. Review the proposed merge again.');
        }
      }
      const mergedIds = new Set(mergeBlockIds as string[]);
      const outgoing = new Set([...(keeper.links ?? []), ...merging.flatMap(block => block!.links)]);
      outgoing.delete(keepBlockId);
      for (const id of mergedIds) outgoing.delete(id);
      const blocks = canvas.blocks.map(block => {
        if (mergedIds.has(block.id)) return { ...block, archived: true };
        const links = block.id === keepBlockId ? [...outgoing] : [...new Set(block.links.map(id => mergedIds.has(id) ? keepBlockId : id))]
          .filter(id => id !== block.id);
        const linkTypes = Object.fromEntries(Object.entries(block.linkTypes ?? {}).map(([id, relation]) => [mergedIds.has(id) ? keepBlockId : id, relation])
          .filter(([id]) => links.includes(id)));
        return { ...block, ...(block.id === keepBlockId ? { content } : {}), links,
          ...(Object.keys(linkTypes).length ? { linkTypes } : { linkTypes: undefined }) };
      });
      const versions = this.versionFile(keeper.id);
      await versions.init(keeper.content);
      if (content !== keeper.content) {
        await versions.commit(content, `Merge ${merging.map(block => block!.title).join(', ')} into ${keeper.title}`, actor);
        await writeFile(this.docFile(keeper.file), content);
      }
      const afterCanvas = { ...beforeCanvas, blocks: blocks.map(storedBlock) };
      const workspace = (await this.listWorkspaces()).find(item => item.id === canvas.workspaceId);
      const otherCanvases: MergeJournal['otherCanvases'] = [];
      for (const summary of workspace?.canvases ?? []) {
        if (summary.id === canvasId) continue;
        const before = await this.readJson<StoredCanvas>(this.canvasFile(summary.id));
        let changed = false;
        const mapped = before.blocks.map(block => {
          if (!block.crossLinks?.some(link => link.canvasId === canvasId && mergedIds.has(link.blockId))) return block;
          changed = true;
          const links = new Map<string, CrossLink>();
          for (const link of block.crossLinks) {
            const next = link.canvasId === canvasId && mergedIds.has(link.blockId)
              ? { ...link, blockId: keepBlockId } : link;
            links.set(`${next.canvasId}:${next.blockId}`, next);
          }
          return { ...block, crossLinks: [...links.values()] };
        });
        if (changed) otherCanvases.push({ id: summary.id, before, after: { ...before, blocks: mapped } });
      }
      await atomicJson(this.canvasFile(canvasId), afterCanvas);
      for (const other of otherCanvases) await atomicJson(this.canvasFile(other.id), other.after);
      let tasks: CanvasTask[] = [];
      try { tasks = await this.readJson<CanvasTask[]>(this.tasksFile(canvasId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const beforeTasks = structuredClone(tasks);
      if (tasks.length) {
        const titles = merging.map(block => block!.title).join(', ');
        const next = tasks.map(task => task.blockIds.some(id => mergedIds.has(id))
          ? commentedTask({ ...task, blockIds: [...new Set(task.blockIds.map(id => mergedIds.has(id) ? keepBlockId : id))] },
            `Merged ${titles} into ${keeper.title}`, actor) : task);
        await atomicJson(this.tasksFile(canvasId), next);
        tasks = next;
      }
      const mergeId = randomUUID();
      await atomicJson(this.mergeFile(mergeId), { mergeId, canvasId, keepBlockId,
        beforeCanvas, afterCanvas, beforeTasks, afterTasks: tasks,
        beforeContent: keeper.content, afterContent: content, otherCanvases } satisfies MergeJournal, 0o600);
      return { mergeId, keepBlockId, archivedBlockIds: [...mergedIds], contentHash: contentHash(content) };
    });
  }

  async undoMerge(mergeId: string, actor = 'api'): Promise<{ mergeId: string; reverted: true }> {
    if (!/^[a-f0-9-]{36}$/.test(mergeId)) throw new ApiError(400, 'Invalid merge ID');
    return this.serialize(async () => {
      let journal: MergeJournal;
      try { journal = await this.readJson<MergeJournal>(this.mergeFile(mergeId)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Merge not found');
        throw error;
      }
      if (journal.undone) throw new ApiError(409, 'Merge already undone');
      const current = await this.readJson<StoredCanvas>(this.canvasFile(journal.canvasId));
      let tasks: CanvasTask[] = [];
      try { tasks = await this.readJson<CanvasTask[]>(this.tasksFile(journal.canvasId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const keeper = current.blocks.find(block => block.id === journal.keepBlockId);
      const currentContent = keeper ? await readFile(this.docFile(keeper.file), 'utf8') : undefined;
      if (JSON.stringify(current) !== JSON.stringify(journal.afterCanvas)
        || JSON.stringify(tasks) !== JSON.stringify(journal.afterTasks)
        || currentContent !== journal.afterContent) throw new ApiError(409, 'Documents changed since the merge');
      for (const other of journal.otherCanvases ?? []) {
        const currentOther = await this.readJson<StoredCanvas>(this.canvasFile(other.id));
        if (JSON.stringify(currentOther) !== JSON.stringify(other.after)) throw new ApiError(409, 'Cross-canvas links changed since the merge');
      }
      this.locks.check(journal.canvasId, journal.keepBlockId, actor);
      const versions = this.versionFile(journal.keepBlockId);
      await versions.commit(journal.beforeContent, 'Undo merge', actor);
      await writeFile(this.docFile(keeper!.file), journal.beforeContent);
      await atomicJson(this.canvasFile(journal.canvasId), journal.beforeCanvas);
      for (const other of journal.otherCanvases ?? []) await atomicJson(this.canvasFile(other.id), other.before);
      await atomicJson(this.tasksFile(journal.canvasId), journal.beforeTasks);
      journal.undone = true;
      await atomicJson(this.mergeFile(mergeId), journal, 0o600);
      return { mergeId, reverted: true };
    });
  }

  async moveBlockToCanvas(canvasId: string, blockId: string, targetCanvasId: string, actor = 'api'):
    Promise<{ fromCanvasId: string; toCanvasId: string; blockId: string }> {
    if (!validId(blockId) || !validId(targetCanvasId) || canvasId === targetCanvasId) throw new ApiError(400, 'Choose another canvas in this workspace');
    return this.serialize(async () => {
      const source = await this.getCanvas(canvasId, true);
      const target = await this.getCanvas(targetCanvasId, true);
      if (source.workspaceId !== target.workspaceId) throw new ApiError(400, 'Documents can move only within one workspace');
      const block = source.blocks.find(item => item.id === blockId);
      if (!block || block.archived) throw new ApiError(404, 'Document not found');
      this.locks.check(canvasId, blockId, actor);
      const moved: CanvasBlock = { ...block, ...freeBlockPosition(target.blocks, { x: 100, y: 100 }),
        links: [], linkTypes: undefined,
        crossLinks: [...(block.crossLinks ?? []), ...block.links.map(id => ({ canvasId, blockId: id,
          ...(block.linkTypes?.[id] ? { relation: block.linkTypes[id] } : {}) }))].slice(0, 20),
      };
      const remaining = source.blocks.filter(item => item.id !== blockId).map(item => {
        if (!item.links.includes(blockId)) return item;
        const links = item.links.filter(id => id !== blockId);
        const linkTypes = { ...item.linkTypes };
        const relation = linkTypes[blockId];
        delete linkTypes[blockId];
        return { ...item, links, linkTypes: Object.keys(linkTypes).length ? linkTypes : undefined,
          crossLinks: [...(item.crossLinks ?? []), { canvasId: targetCanvasId, blockId,
            ...(relation ? { relation } : {}) }].slice(0, 20) };
      });
      await atomicJson(this.canvasFile(targetCanvasId), { ...target, blocks: [...target.blocks, moved].map(storedBlock) });
      try { await atomicJson(this.canvasFile(canvasId), { ...source, blocks: remaining.map(storedBlock) }); }
      catch (error) {
        await atomicJson(this.canvasFile(targetCanvasId), { ...target, blocks: target.blocks.map(storedBlock) });
        throw error;
      }
      return { fromCanvasId: canvasId, toCanvasId: targetCanvasId, blockId };
    });
  }

  async updateLayout(canvasId: string, positions: unknown): Promise<CanvasDocument> {
    const updates = validPositions(positions);
    return this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const known = new Set(canvas.blocks.map(block => block.id));
      if (updates.some(item => !known.has(item.blockId))) throw new ApiError(404, 'Layout includes an unknown block');
      const byId = new Map(updates.map(item => [item.blockId, item]));
      const blocks = canvas.blocks.map(block => {
        const update = byId.get(block.id);
        if (!update) return block;
        const group = update.group === undefined ? block.group : update.group ?? undefined;
        const moved: CanvasBlock = { ...block, x: update.x, y: update.y, group };
        if (!group) delete moved.group;
        return moved;
      });
      await atomicJson(this.canvasFile(canvasId), { ...canvas, blocks: blocks.map(storedBlock) });
      return { ...canvas, blocks };
    });
  }

  async deleteBlock(canvasId: string, blockId: string, actor = 'api'): Promise<void> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    await this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const block = canvas.blocks.find(item => item.id === blockId);
      if (!block) throw new ApiError(404, 'Block not found');
      this.locks.check(canvasId, blockId, actor);
      const versions = this.versionFile(blockId);
      await versions.init(block.content);
      await versions.recordDeletion(`Delete ${block.title} from canvas ${canvas.name}`, actor);
      const remaining = canvas.blocks.filter(item => item.id !== blockId).map(item => ({ ...item, links: item.links.filter(link => link !== blockId) }));
      await atomicJson(this.canvasFile(canvasId), { ...canvas, blocks: remaining.map(storedBlock) });
      await rm(this.docFile(block.file));
      this.locks.forget(canvasId, blockId);
    });
  }

  async lockBlock(canvasId: string, blockId: string, actor: string, input: Record<string, unknown>): Promise<DocumentLock> {
    await this.requireBlock(canvasId, blockId);
    return this.locks.acquire(canvasId, blockId, actor, input);
  }

  async unlockBlock(canvasId: string, blockId: string, actor: string, force: boolean): Promise<void> {
    await this.requireBlock(canvasId, blockId);
    this.locks.release(canvasId, blockId, actor, force);
  }

  private async requireBlock(canvasId: string, blockId: string): Promise<CanvasBlock> {
    if (!validId(blockId)) throw new ApiError(400, 'Invalid block ID');
    const block = (await this.getCanvas(canvasId, true)).blocks.find(item => item.id === blockId);
    if (!block) throw new ApiError(404, 'Block not found');
    return block;
  }

  private async documentVersions(canvasId: string, blockId: string): Promise<{ versions: DocumentVersions; block: CanvasBlock }> {
    const block = await this.requireBlock(canvasId, blockId);
    const versions = this.versionFile(blockId);
    await versions.init(block.content);
    return { versions, block };
  }

  async documentHistory(canvasId: string, blockId: string) {
    return this.serialize(async () => (await this.documentVersions(canvasId, blockId)).versions.status());
  }

  async createDocumentBranch(canvasId: string, blockId: string, name: string) {
    return this.serialize(async () => (await this.documentVersions(canvasId, blockId)).versions.createBranch(name));
  }

  private async changeDocumentVersion(canvasId: string, blockId: string, actor: string,
    change: (versions: DocumentVersions) => Promise<{ status: Awaited<ReturnType<DocumentVersions['status']>>; content: string }>) {
    return this.serialize(async () => {
      this.locks.check(canvasId, blockId, actor);
      const { versions, block } = await this.documentVersions(canvasId, blockId);
      const { status, content } = await change(versions);
      await writeFile(this.docFile(block.file), content);
      return status;
    });
  }

  async switchDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.switchBranch(name));
  }
  async mergeDocumentBranch(canvasId: string, blockId: string, name: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.mergeBranch(name, actor));
  }
  async restoreDocumentRevision(canvasId: string, blockId: string, revision: string, actor = 'api') {
    return this.changeDocumentVersion(canvasId, blockId, actor, versions => versions.restoreRevision(revision, actor));
  }

  async search(query: string): Promise<SearchHit[]> {
    if (query.length > 200) throw new ApiError(400, 'Search query is too long');
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const workspaces = await this.listWorkspaces();
    const canvasIds = workspaces.flatMap(workspace => workspace.canvases.map(canvas => canvas.id));
    const canvases = await Promise.all(canvasIds.map(id => this.getCanvas(id)));
    const hits = canvases.flatMap(canvas => canvas.blocks.flatMap(block => {
      const body = this.searchableBody(block);
      const titleAt = block.title.toLocaleLowerCase().indexOf(needle);
      const bodyAt = body.toLocaleLowerCase().indexOf(needle);
      if (titleAt < 0 && bodyAt < 0) return [];
      const matchIn = titleAt >= 0 ? 'title' : 'body';
      return [{
        canvasId: canvas.id, canvasName: canvas.name, blockId: block.id, title: block.title,
        excerpt: matchIn === 'title' ? searchExcerpt(block.title, titleAt, needle.length) : searchExcerpt(body, bodyAt, needle.length),
        group: block.group, tags: block.tags ?? [], kind: block.kind, matchIn,
      } satisfies SearchHit];
    }));
    return hits.sort((a, b) => Number(b.matchIn === 'title') - Number(a.matchIn === 'title') ||
      a.canvasName.localeCompare(b.canvasName) || a.title.localeCompare(b.title) || a.blockId.localeCompare(b.blockId));
  }

  async listTasks(canvasId: string): Promise<CanvasTask[]> {
    await this.getCanvas(canvasId);
    try { return await this.readJson<CanvasTask[]>(this.tasksFile(canvasId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async changeTasks<T>(canvasId: string, change: (tasks: CanvasTask[], known: Set<string>) => { tasks: CanvasTask[]; result: T }): Promise<T> {
    return this.serialize(async () => {
      const canvas = await this.getCanvas(canvasId, true);
      const { tasks, result } = change(await this.listTasks(canvasId), new Set(canvas.blocks.map(block => block.id)));
      if (tasks.length > 500) throw new ApiError(400, 'A canvas can hold at most 500 tasks');
      await atomicJson(this.tasksFile(canvasId), tasks);
      return result;
    });
  }

  private static taskIndex(tasks: CanvasTask[], taskId: string): number {
    const index = tasks.findIndex(task => task.id === taskId);
    if (index < 0) throw new ApiError(404, 'Task not found');
    return index;
  }

  async createTask(canvasId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    return this.changeTasks(canvasId, (tasks, known) => {
      const task = newTask(input, actor, known);
      return { tasks: [...tasks, task], result: task };
    });
  }

  private async replaceTask(canvasId: string, taskId: string, update: (task: CanvasTask, known: Set<string>) => CanvasTask): Promise<CanvasTask> {
    return this.changeTasks(canvasId, (tasks, known) => {
      const index = CanvasStore.taskIndex(tasks, taskId);
      const task = update(tasks[index], known);
      return { tasks: tasks.map((item, position) => position === index ? task : item), result: task };
    });
  }

  async updateTask(canvasId: string, taskId: string, input: Record<string, unknown>, actor: string): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, (task, known) => patchedTask(task, input, actor, known));
  }

  async claimTask(canvasId: string, taskId: string, actor: string, force: boolean): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, task => claimedTask(task, actor, force));
  }

  async commentTask(canvasId: string, taskId: string, text: unknown, actor: string): Promise<CanvasTask> {
    return this.replaceTask(canvasId, taskId, task => commentedTask(task, text, actor));
  }

  async deleteTask(canvasId: string, taskId: string): Promise<void> {
    await this.changeTasks(canvasId, tasks => {
      const index = CanvasStore.taskIndex(tasks, taskId);
      return { tasks: tasks.filter((_, position) => position !== index), result: undefined };
    });
  }

  private async privateSettings(): Promise<PrivateSettings> {
    try { return await this.readJson<PrivateSettings>(this.settingsFile()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { ...defaultPrivateSettings };
    }
  }

  /** Full settings including secrets. Only server code may call this. */
  async secretSettings(): Promise<PrivateSettings> { return this.privateSettings(); }

  async getSettings(): Promise<ChatSettings> {
    return publicSettings(await this.privateSettings());
  }

  async getApiKey(): Promise<string> {
    return providerKey(await this.privateSettings());
  }

  async getJevApiKey(): Promise<string> {
    return jevKey(await this.privateSettings());
  }

  async updateSettings(input: Record<string, unknown>): Promise<ChatSettings> {
    return this.serialize(async () => {
      const settings = updatedSettings(await this.privateSettings(), input);
      await atomicJson(this.settingsFile(), settings, 0o600);
      return publicSettings(settings);
    });
  }

  async createMcpToken(name: unknown): Promise<{ token: string; settings: ChatSettings }> {
    return this.serialize(async () => {
      const settings = await this.privateSettings();
      if ((settings.mcpTokens ?? []).length >= 20) throw new ApiError(400, 'Revoke an old token before creating another (limit 20)');
      const { token, stored } = newMcpToken(name);
      const next = { ...settings, mcpTokens: [...(settings.mcpTokens ?? []), stored] };
      await atomicJson(this.settingsFile(), next, 0o600);
      return { token, settings: publicSettings(next) };
    });
  }

  async revokeMcpToken(id: string): Promise<ChatSettings> {
    return this.serialize(async () => {
      const settings = await this.privateSettings();
      if (!(settings.mcpTokens ?? []).some(token => token.id === id)) throw new ApiError(404, 'Token not found');
      const next = { ...settings, mcpTokens: (settings.mcpTokens ?? []).filter(token => token.id !== id) };
      await atomicJson(this.settingsFile(), next, 0o600);
      return publicSettings(next);
    });
  }

  /** Returns the token name for a valid MCP token and records when it was last used. */
  async verifyMcpToken(token: string): Promise<string | null> {
    if (!token) return null;
    for (const fixed of [process.env.SYMBIKNOW_MCP_TOKEN, process.env.ALLTEAM_MCP_TOKEN]) {
      if (fixed && safeEqual(token, fixed)) return 'env token';
    }
    for (const fixed of [process.env.SYMBIKNOW_ACCESS_TOKEN, process.env.ALLTEAM_ACCESS_TOKEN]) {
      if (fixed && safeEqual(token, fixed)) return 'access token';
    }
    const hash = hashToken(token);
    const settings = await this.privateSettings();
    const stored = (settings.mcpTokens ?? []).find(item => safeEqual(item.hash, hash));
    if (!stored) return null;
    if (!stored.lastUsedAt || Date.now() - Date.parse(stored.lastUsedAt) > 60_000) {
      void this.serialize(async () => {
        const latest = await this.privateSettings();
        const mcpTokens = (latest.mcpTokens ?? []).map(item => item.id === stored.id ? { ...item, lastUsedAt: new Date().toISOString() } : item);
        await atomicJson(this.settingsFile(), { ...latest, mcpTokens }, 0o600);
      }).catch(() => undefined);
    }
    return stored.name;
  }
}
