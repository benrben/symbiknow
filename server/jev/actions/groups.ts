import { createHash } from 'node:crypto';
import { groupParent, normalizedGroup, validGroupKey } from '../../../shared/groups.js';
import type { JevVocabularyTerm } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';

/** Keep native group paths intact; human vocabulary names use the inspector's encoding. */
export function membershipGroupKey(name: string): string {
  const normalized = normalizedGroup(name);
  if (validGroupKey(normalized)) return normalized;
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  const fallback = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `custom:${slug || fallback}`;
}

export function matchesGroupTerm(key: string | undefined, term: JevVocabularyTerm): boolean {
  if (vocabularyGroupKey(term) === normalizedGroup(key)) return true;
  return [term.name, ...term.aliases, term.id].some(name => membershipGroupKey(name) === normalizedGroup(key));
}

export function vocabularyGroupKey(term: JevVocabularyTerm): string { return term.groupKey ?? membershipGroupKey(term.name); }

export function childGroupKey(parent: string, name: string): string {
  const leaf = membershipGroupKey(name).split('/').at(-1)!.replace(/^[^:]+:/, '');
  const key = `${parent}/${leaf}`;
  if (!validGroupKey(key)) throw new ApiError(400, 'Group hierarchy exceeds the native path limits');
  return key;
}

export function renamedGroupKey(previous: JevVocabularyTerm, name: string): string {
  const parent = groupParent(vocabularyGroupKey(previous));
  return parent ? childGroupKey(parent, name) : membershipGroupKey(name);
}
