import { createHash } from 'node:crypto';
import type { CanvasBlock, CanvasDocument, CanvasTask } from '../shared/types.js';

export type StoredBlock = Omit<CanvasBlock, 'content' | 'contentLoaded' | 'contentHash' | 'lock'>;
export type StoredCanvas = Omit<CanvasDocument, 'blocks' | 'groupLabels'> & { blocks: StoredBlock[] };
export type MergeJournal = { mergeId: string; canvasId: string; keepBlockId: string; beforeCanvas: StoredCanvas;
  afterCanvas: StoredCanvas; beforeTasks: CanvasTask[]; afterTasks: CanvasTask[];
  beforeContent: string; afterContent: string;
  otherCanvases: { id: string; before: StoredCanvas; after: StoredCanvas }[]; recoveryCanvases?: StoredCanvas[]; undone?: boolean };

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function canvasData<T extends { id: string; name: string; workspaceId: string; blocks: unknown[] }>(canvas: T): Pick<T, 'id' | 'name' | 'workspaceId' | 'blocks'> {
  return { id: canvas.id, name: canvas.name, workspaceId: canvas.workspaceId, blocks: canvas.blocks };
}

export function fileSignature(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export function storedBlock(block: CanvasBlock): StoredBlock {
  return {
    id: block.id, title: block.title, file: block.file, kind: block.kind,
    x: block.x, y: block.y, width: block.width, height: block.height, links: block.links,
    purpose: block.purpose, reviewer: block.reviewer, group: block.group, workArea: block.workArea, tags: block.tags,
    linkTypes: block.linkTypes, crossLinks: block.crossLinks, quality: block.quality, archived: block.archived, stale: block.stale,
    incarnation: block.incarnation, sourceGeneration: block.sourceGeneration, metadataRevision: block.metadataRevision,
    jevOwnership: block.jevOwnership, jevMutationId: block.jevMutationId, headline: block.headline,
    freshness: block.freshness, processingExcluded: block.processingExcluded,
  };
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function validId(id: string): boolean {
  return idPattern.test(id);
}
