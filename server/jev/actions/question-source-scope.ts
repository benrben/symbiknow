import type { JevQuestionSet } from './question-set-collector.js';
import { compileSharedQuestionStates } from './question-state-pool.js';

export interface SourceScopedQuestionGroup { indices: number[]; sets: JevQuestionSet[] }

function sourceSignature(set: JevQuestionSet): string {
  // Reuse the transport's recursive exact-source detector and JSON wire projection.
  const projected = compileSharedQuestionStates([set.state]);
  const sources = projected.sourceStates.map(source => JSON.stringify(source)).sort();
  const family = Object.hasOwn(set.state, 'organizationSignals') ? 'filing' : 'document';
  return JSON.stringify({ family, sources });
}

/** Batch identical source objects within the filing or ordinary document context family. */
export function sourceScopedQuestionGroups(sets: JevQuestionSet[]): SourceScopedQuestionGroup[] {
  const groups: SourceScopedQuestionGroup[] = [];
  const scopes = new Map<string, SourceScopedQuestionGroup>();
  sets.forEach((set, index) => {
    const signature = sourceSignature(set);
    let group = scopes.get(signature);
    if (!group) {
      group = { indices: [], sets: [] };
      scopes.set(signature, group);
      groups.push(group);
    }
    group.indices.push(index);
    group.sets.push(set);
  });
  return groups;
}
