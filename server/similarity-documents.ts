import { createHash } from 'node:crypto';
import { documentText } from '../shared/document-text.js';
import type { CanvasBlock } from '../shared/types.js';
import type { IndexedDocument } from './similarity-types.js';
import { shingles, tokenize } from './similarity-text.js';

export function documentFingerprint(block: CanvasBlock): string {
  const hash = block.contentHash ?? createHash('sha256').update(block.content).digest('hex').slice(0, 16);
  return `${hash}\u0000${block.title}`;
}

export function unchangedDocument(old: IndexedDocument | undefined, canvasId: string, fingerprint: string): boolean {
  return old?.fingerprint === fingerprint && old.canvasId === canvasId;
}

export function indexedDocument(canvasId: string, block: CanvasBlock, fingerprint: string): IndexedDocument {
  const words = tokenize(`${block.title} ${block.title} ${block.title} ${documentText(block.content)}`);
  const terms = new Map<string, number>();
  for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
  return { canvasId, fingerprint, terms, shingles: shingles(tokenize(documentText(block.content))) };
}
