import { api } from './api';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { InvestigationSourceRef, SourceCheck } from './saved-investigation-types';

function freshness(block: CanvasBlock | undefined, ref: InvestigationSourceRef): SourceCheck['state'] {
  if (!block) return 'missing';
  if (!ref.contentHash || !block.contentHash) return 'unknown';
  return ref.contentHash === block.contentHash ? 'current' : 'changed';
}
function sourceCheck(ref: InvestigationSourceRef, byCanvas: Map<string, CanvasDocument>): SourceCheck {
  const block = byCanvas.get(ref.canvasId)?.blocks.find(item => item.id === ref.blockId);
  return {
    canvasId: ref.canvasId, blockId: ref.blockId, oldHash: ref.contentHash, currentHash: block?.contentHash,
    title: block?.title ?? ref.blockId, savedExcerpt: ref.excerpt, currentExcerpt: block?.content.slice(0, 480), state: freshness(block, ref)
  };
}
function validDocument(document: CanvasDocument): boolean {
  return !!document && typeof document.id === 'string' && Array.isArray(document.blocks);
}
export async function checkInvestigationSources(refs: InvestigationSourceRef[]): Promise<SourceCheck[]> {
  const documents = await Promise.all([...new Set(refs.map(ref => ref.canvasId))].map(id => api<CanvasDocument>('/canvases/' + encodeURIComponent(id))));
  if (!documents.every(validDocument)) throw new Error('Current canvas data is unavailable.');
  const byCanvas = new Map(documents.map(document => [document.id, document]));
  return refs.map(ref => sourceCheck(ref, byCanvas));
}
