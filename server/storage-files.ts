import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasBlock, CrossLink, WorkspaceSummary } from '../shared/types.js';
import { DocumentVersions } from './version-control.js';
import { getSimilarityIndex, type SimilarityIndex } from './similarity.js';
import { DocumentLocks } from './coordination.js';
import { canvasData, contentHash, fileSignature, storedBlock, type StoredCanvas } from './storage-shapes.js';
import { captureApiMutationAuthority } from './api-mutation-authority.js';

const contentCacheLimit = 16 * 1024 * 1024;
const writerQueues = new Map<string, Promise<unknown>>();
type WriterLease = { root: string; active: boolean };
const activeWriter = new AsyncLocalStorage<WriterLease>();

export async function atomicJson(file: string, value: unknown, mode = 0o644, spacing = 2,
  onSerialized?: (content: string) => void): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const payload = path.basename(path.dirname(file)) === 'canvases' ? canvasData(value as StoredCanvas) : value;
    const content = JSON.stringify(payload, null, spacing);
    onSerialized?.(content);
    await writeFile(temporary, content, { mode });
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    await chmod(file, mode);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function durableDocument(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o644);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

type JournalEntry = { id?: unknown; canvasId?: unknown; change?: { canvasId?: unknown } };

function journalEntries(value: unknown): Array<JournalEntry | null> {
  return Array.isArray(value) ? value : [];
}

function entryReferencesCanvas(item: JournalEntry | null, canvasId: string): boolean {
  return item?.canvasId === canvasId || item?.change?.canvasId === canvasId;
}

export function journalReferencesCanvas(journal: Record<string, unknown>, canvasId: string): boolean {
  return journal.canvasId === canvasId ||
    journalEntries(journal.otherCanvases).some(item => item?.id === canvasId || entryReferencesCanvas(item, canvasId)) ||
    ['changes', 'steps', 'suggestions'].some(key => journalEntries(journal[key]).some(item => entryReferencesCanvas(item, canvasId)));
}

export class StorageFiles {
  private readonly documentMetadataCache = new Map<string, { contentHash: string; lastModified?: string; authors: string[]; latestAuthor?: string }>();
  private readonly contentCache = new Map<string, { signature: string; content: string; bytes: number }>();
  private contentCacheBytes = 0;

  constructor(readonly root: string, private readonly locks: DocumentLocks) {}

  /** Background subscribers must queue their writes instead of inheriting the publishing transaction. */
  outsideWriter<T>(action: () => T): T { return activeWriter.exit(action); }

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const root = path.resolve(this.root);
    const lease = activeWriter.getStore();
    if (lease?.root === root && lease.active) return action();
    const authorize = captureApiMutationAuthority();
    const invoke = () => {
      const current = { root, active: true };
      return activeWriter.run(current, async () => {
        try { await authorize?.(); return await action(); }
        finally { current.active = false; }
      });
    };
    const next = (writerQueues.get(root) ?? Promise.resolve()).then(invoke, invoke);
    writerQueues.set(root, next.then(() => undefined, () => undefined));
    return next;
  }

  workspacesFile(): string { return path.join(this.root, 'workspaces.json'); }

  canvasFile(id: string): string { return path.join(this.root, 'canvases', `${id}.json`); }

  tasksFile(id: string): string { return path.join(this.root, 'tasks', `${id}.json`); }

  settingsFile(): string { return path.join(this.root, 'settings.json'); }

  mcpActivityFile(): string { return path.join(this.root, 'mcp-activity.json'); }

  mergeFile(id: string): string { return path.join(this.root, 'jev-merges', `${id}.json`); }

  docFile(file: string): string { return path.join(this.root, file); }

  versionFile(blockId: string): DocumentVersions { return new DocumentVersions(path.join(this.root, '.versions', blockId)); }

  jevCacheFile(canvasId: string): string { return path.join(this.root, 'jev-cache', `${canvasId}.json`); }

  similarityIndex(workspaceId: string): SimilarityIndex { return getSimilarityIndex(`${this.root}:${workspaceId}`); }

  async readDocumentMetadata(block: CanvasBlock): Promise<{ lastModified?: string; authors: string[]; latestAuthor?: string }> {
    // A caller may hold a snapshot from before a concurrent write. Initialize history
    // from the current file so a metadata read never imports stale snapshot content.
    const content = await this.readDocument(block.file);
    const current = { ...block, content, contentHash: contentHash(content) };
    const hash = current.contentHash;
    const cached = this.documentMetadataCache.get(block.id);
    if (cached?.contentHash === hash) return cached;
    const versions = this.versionFile(block.id);
    await versions.init(current.content);
    const status = await versions.status();
    const authors = [...new Set(status.commits.map(commit => commit.author))].slice(0, 3);
    const metadata = { contentHash: hash, lastModified: status.commits[0]?.createdAt,
      authors, latestAuthor: status.commits[0]?.author };
    this.documentMetadataCache.set(block.id, metadata);
    return metadata;
  }

  async existingCrossLinks(workspaceId: string, sourceCanvasId: string, links: CrossLink[],
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

  async readDocument(file: string): Promise<string> {
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
        // An over-budget cache necessarily has an entry to evict.
        const oldest = this.contentCache.keys().next().value!;
        this.contentCacheBytes -= this.contentCache.get(oldest)!.bytes;
        this.contentCache.delete(oldest);
      }
    }
    return content;
  }

  async readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }

  forgetCanvasMemory(canvas: StoredCanvas): void {
    for (const block of canvas.blocks) {
      this.locks.forget(canvas.id, block.id);
      this.documentMetadataCache.delete(block.id);
      const file = this.docFile(block.file);
      const cached = this.contentCache.get(file);
      if (cached) { this.contentCacheBytes -= cached.bytes; this.contentCache.delete(file); }
    }
    this.similarityIndex(canvas.workspaceId).clearCanvas(canvas.id);
  }

  async canvasJournals(canvasId: string): Promise<string[]> {
    const matching: string[] = [];
    // Journals can contain complete document snapshots. Discard ones that refer to this canvas.
    for (const directory of ['jev-merges', 'jev-runs']) {
      let files: string[];
      try { files = await readdir(path.join(this.root, directory)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files.filter(name => name.endsWith('.json'))) {
        const journalPath = path.join(this.root, directory, file);
        const journal = await this.readJson<Record<string, unknown>>(journalPath);
        if (journalReferencesCanvas(journal, canvasId)) matching.push(journalPath);
      }
    }
    return matching;
  }

  async seed(): Promise<void> {
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
}
