import type { JevValues, JevWorkspaceState } from '../../shared/jev-types.js';
import { JEV_QUESTION_VERSION, type JevInputDocument } from './actions/context.js';

const sourceFields = ['workspaceId', 'canvasId', 'blockId', 'incarnation', 'sourceGeneration', 'contentHash'] as const;
function currentProfileSource(profile: JevValues | undefined, document: JevInputDocument): boolean {
  const source = profile?.source as JevValues | undefined;
  return Boolean(source && profile?.questionVersion === JEV_QUESTION_VERSION
    && sourceFields.every(field => source[field] === document.snapshot[field]));
}
function logicalIndex(profile: JevValues): JevValues | undefined {
  const index = profile.logicalIndex;
  return index && typeof index === 'object' && !Array.isArray(index) && index.version === 1 && Array.isArray(index.topics)
    ? index : undefined;
}

/** Only indexes derived from this still-visible source incarnation enter another decision. */
export function currentDocumentIndexes(state: JevWorkspaceState, documents: JevInputDocument[]): Record<string, JevValues> {
  const indexes: Record<string, JevValues> = {};
  for (const document of documents) {
    if (document.block.archived || document.block.processingExcluded) continue;
    const key = `${document.canvasId}:${document.block.id}`;
    const profile = state.profiles[key];
    if (!currentProfileSource(profile, document)) continue;
    const index = logicalIndex(profile);
    if (index) indexes[key] = index;
  }
  return indexes;
}
