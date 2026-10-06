import type { JevMutation, JevProposal, JevValues, JevWorkspaceState } from '../../shared/jev-types.js';
import type { CanvasStore } from '../storage.js';
import { ApiError } from '../errors.js';
import { checkVocabularyMutation } from './vocabulary.js';
import { normalizedGroup } from '../../shared/groups.js';

type VocabularyMutation = Extract<JevMutation, { kind: 'vocabulary' }>;
function profileKey(proposal: JevProposal): string {
  const source = proposal.sources.find(item => proposal.mutation.kind === 'derived' && item.blockId === proposal.mutation.blockId);
  return source ? `${source.canvasId}:${source.blockId}` : `workspace:${proposal.action}`;
}
function derivedMutation(state: JevWorkspaceState, proposal: JevProposal, mutation: Extract<JevMutation, { kind: 'derived' }>): JevMutation {
  const key = profileKey(proposal);
  const before = { ...mutation, values: state.profiles[key] ?? {} };
  const source = proposal.sources.find(item => item.blockId === mutation.blockId);
  const checkedSource: JevValues = source ? { source: JSON.parse(JSON.stringify(source)) } : {};
  state.profiles[key] = proposal.jobId.startsWith('undo:') ? mutation.values : { ...state.profiles[key], ...mutation.values, ...checkedSource };
  return before;
}
function vocabularyMutation(state: JevWorkspaceState, mutation: VocabularyMutation): JevMutation {
  checkVocabularyMutation(state.vocabulary, mutation);
  const previous = state.vocabulary.find(term => term.id === mutation.term.id);
  if (mutation.operation === 'remove') state.vocabulary = state.vocabulary.filter(term => term.id !== mutation.term.id);
  else {
    state.vocabulary = [...state.vocabulary.filter(term => term.id !== mutation.term.id), mutation.term];
  }
  return { kind: 'vocabulary', operation: previous ? 'restore' : 'remove', term: previous ?? mutation.term };
}
export function stateMutation(state: JevWorkspaceState, proposal: JevProposal): JevMutation {
  if (proposal.mutation.kind === 'derived') return derivedMutation(state, proposal, proposal.mutation);
  if (proposal.mutation.kind === 'vocabulary') return vocabularyMutation(state, proposal.mutation);
  throw new ApiError(400, 'Unknown workspace mutation');
}
export async function checkVocabularyMembers(store: CanvasStore, workspaceId: string, mutation: JevMutation): Promise<void> {
  if (mutation.kind !== 'vocabulary') return;
  for (const member of mutation.term.members) {
    const canvas = await store.getCanvas(member.canvasId, true);
    if (canvas.workspaceId !== workspaceId || !canvas.blocks.some(block => block.id === member.blockId)) throw new ApiError(409, 'A vocabulary member is unavailable in this workspace');
  }
}
function removableGroup(mutation: JevMutation): mutation is VocabularyMutation {
  return mutation.kind === 'vocabulary' && mutation.operation === 'remove' && mutation.term.kind === 'group' && Boolean(mutation.term.groupKey);
}
export async function checkVocabularyReferences(store: CanvasStore, mutation: JevMutation): Promise<void> {
  if (!removableGroup(mutation)) return;
  const key = normalizedGroup(mutation.term.groupKey)!;
  for (const member of mutation.term.members) {
    const block = (await store.getCanvas(member.canvasId, true)).blocks.find(item => item.id === member.blockId);
    const group = normalizedGroup(block?.group);
    if (group === key || group?.startsWith(`${key}/`)) throw new ApiError(409, 'Undo the document placements before removing their group definition');
  }
}
