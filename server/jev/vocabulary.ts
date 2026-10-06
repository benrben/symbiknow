import type { JevMutation, JevVocabularyTerm } from '../../shared/jev-types.js';
import { groupParent, normalizedGroup, validGroupKey } from '../../shared/groups.js';
import { ApiError } from '../errors.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validId } from '../storage-shapes.js';

type VocabularyMutation = Extract<JevMutation, { kind: 'vocabulary' }>;
const operations = ['nominate', 'define', 'promote', 'rename', 'alias', 'retire', 'restore', 'merge', 'split', 'remove'] as const;
const name = z.string().min(1).max(200).refine(value => value.trim().length > 0);
const identifier = z.string().refine(validId);
const termSchema = z.strictObject({ id: name, kind: z.enum(['group', 'label', 'entity']), name,
  parentId: name.optional(), groupKey: z.string().refine(validGroupKey).optional(), definition: z.string().max(8000),
  aliases: z.array(name).max(100), state: z.enum(['candidate', 'active', 'retired']), version: z.number().int().safe().positive(),
  members: z.array(z.strictObject({ canvasId: identifier, blockId: identifier })).max(10000) })
  .refine(term => term.kind === 'group' || (term.parentId === undefined && term.groupKey === undefined));
const mutationSchema = z.strictObject({ kind: z.literal('vocabulary'), operation: z.enum(operations),
  term: termSchema, previousId: name.optional() });

export function validateVocabularyMutation(mutation: VocabularyMutation): void {
  if (!mutationSchema.safeParse(mutation).success) throw new ApiError(400, 'Invalid vocabulary mutation');
}

function activeParent(term: JevVocabularyTerm, vocabulary: JevVocabularyTerm[]): JevVocabularyTerm {
  const parent = vocabulary.find(item => item.id === term.parentId);
  if (!parent || parent.kind !== 'group' || parent.state !== 'active') throw new ApiError(409, 'Approve an active parent group first');
  return parent;
}
function parentPath(term: JevVocabularyTerm, parent: JevVocabularyTerm): void {
  if (!term.groupKey || !parent.groupKey) return;
  if (groupParent(term.groupKey) !== normalizedGroup(parent.groupKey)) throw new ApiError(409, 'The subgroup path does not match its parent');
}
function checkCycle(term: JevVocabularyTerm, parent: JevVocabularyTerm, vocabulary: JevVocabularyTerm[]): void {
  const visited = new Set([term.id]);
  let ancestor: JevVocabularyTerm | undefined = parent;
  while (ancestor) {
    if (visited.has(ancestor.id)) throw new ApiError(409, 'A group cannot be its own ancestor');
    visited.add(ancestor.id);
    ancestor = vocabulary.find(item => item.id === ancestor!.parentId);
  }
}

function assertParent(term: JevVocabularyTerm, vocabulary: JevVocabularyTerm[]): void {
  if (!term.parentId) return;
  const parent = activeParent(term, vocabulary); parentPath(term, parent); checkCycle(term, parent, vocabulary);
}

function checkRemoval(vocabulary: JevVocabularyTerm[], term: JevVocabularyTerm, previous?: JevVocabularyTerm): void {
  if (!previous || !isDeepStrictEqual(previous, term)) throw new ApiError(409, 'Vocabulary changed after this action');
  if (vocabulary.some(child => child.parentId === previous.id && child.state !== 'retired')) throw new ApiError(409, 'Move or retire the subgroups before removing their parent');
}

function collision(previous: JevVocabularyTerm, next: JevVocabularyTerm): boolean {
  if (previous.id === next.id || previous.kind !== next.kind) return false;
  const samePath = Boolean(next.groupKey) && normalizedGroup(previous.groupKey) === normalizedGroup(next.groupKey);
  return previous.name === next.name || samePath;
}

/** Validate the changed term; descendants may be migrated in later checked proposals. */
export function checkVocabularyMutation(vocabulary: JevVocabularyTerm[], mutation: VocabularyMutation): void {
  validateVocabularyMutation(mutation);
  const previous = vocabulary.find(term => term.id === mutation.term.id);
  if (mutation.operation === 'remove') return checkRemoval(vocabulary, mutation.term, previous);
  if (previous && mutation.term.version <= previous.version) throw new ApiError(409, 'Vocabulary changed since the preview');
  if (vocabulary.some(term => collision(term, mutation.term))) throw new ApiError(409, 'Vocabulary name or group path collision');
  assertParent(mutation.term, vocabulary);
}
