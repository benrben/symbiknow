import { createHash } from 'node:crypto';
import type { JevVocabularyTerm } from '../../shared/jev-types.js';
import type { JevDecider } from '../../server/jev.js';
import type { JevEvaluationContext, JevInputDocument } from '../../server/jev/actions/context.js';
import { emptyJevWorkspace } from '../../server/jev/workspace.js';
import type { VocabularyHeldoutCase, VocabularyHeldoutTerm } from './data/vocabulary-heldout.mjs';

export const vocabularyCorpusNames = ['normal', 'heldout', 'independent-heldout'] as const;
export type VocabularyCorpus = typeof vocabularyCorpusNames[number];
export function vocabularyCorpus(args: readonly string[]): VocabularyCorpus {
  const value = args[0] === '--corpus' ? args[1] : args[0] ?? 'normal';
  const expectedLength = args[0] === '--corpus' ? 2 : 1;
  if (args.length > expectedLength || !vocabularyCorpusNames.includes(value as VocabularyCorpus)) {
    throw new Error('Choose vocabulary corpus normal, heldout, or --corpus independent-heldout.');
  }
  return value as VocabularyCorpus;
}
function document(term: VocabularyHeldoutTerm): JevInputDocument {
  return { canvasId: term.canvasId,
    block: { id: term.documentId, title: term.title, content: term.content, file: term.documentId + '.md', kind: 'markdown',
      x: 0, y: 0, width: 400, height: 300, links: [], tags: [term.name] },
    snapshot: { workspaceId: 'synthetic-vocabulary-heldout', canvasId: term.canvasId, blockId: term.documentId,
      incarnation: term.documentId + '-original', sourceGeneration: 1, metadataRevision: 1,
      contentHash: createHash('sha256').update(term.content).digest('hex').slice(0, 16) } };
}
function term(raw: VocabularyHeldoutTerm, id: string): JevVocabularyTerm {
  return { id, name: raw.name, definition: raw.definition, kind: 'label', aliases: [], state: 'active', version: 1,
    members: [{ canvasId: raw.canvasId, blockId: raw.documentId }] };
}
/** Member evidence stays on its original canvas; the empty review canvas exercises the real automatic merge path. */
export function vocabularyHeldoutContext(item: VocabularyHeldoutCase, decider: JevDecider,
  apiKey = 'local-synthetic-fixture'): JevEvaluationContext {
  return { workspaceId: 'synthetic-vocabulary-heldout', documents: [document(item.source), document(item.target)],
    canvases: [{ id: item.source.canvasId, name: item.source.canvasName }, { id: item.target.canvasId, name: item.target.canvasName },
      { id: 'merge-only', name: 'Independent vocabulary review' }],
    vocabulary: [term(item.source, item.id + '-source'), term(item.target, item.id + '-target')], tasks: [],
    settings: emptyJevWorkspace().settings, apiKey, decider };
}
