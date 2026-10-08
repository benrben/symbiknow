import { groupLabel, groupParent, normalizedGroup } from '../../../shared/groups.js';
import type { JevEvaluationContext } from './context.js';
import type { ProposedGroup } from './group-topics.js';
import { vocabularyGroupKey } from './groups.js';

type Authority = { name: string; definition?: string; parentKey?: string; retired: boolean };
function groupAuthority(context: JevEvaluationContext, canvasId: string, key: string): Authority | undefined {
  const term = context.vocabulary.find(term => term.kind === 'group' && vocabularyGroupKey(term) === key);
  if (term) {
    const parent = context.vocabulary.find(parent => parent.kind === 'group' && parent.id === term.parentId);
    return { name: term.name, definition: term.definition, parentKey: parent ? vocabularyGroupKey(parent) : groupParent(key),
      retired: term.state === 'retired' };
  }
  const native = context.canvases.find(canvas => canvas.id === canvasId)?.groups?.find(group => normalizedGroup(group.id) === key);
  return native ? { name: native.name, definition: native.definition, parentKey: groupParent(key), retired: false } : undefined;
}
function parentScope(context: JevEvaluationContext, canvasId: string, key: string | undefined) {
  if (!key) return undefined;
  const parent = groupAuthority(context, canvasId, key);
  return { key, name: parent?.name ?? groupLabel(key), definition: parent?.definition };
}

/** A nomination supplies evidence, never replacement semantics for an existing canonical key. */
export function canonicalGroupScope(context: JevEvaluationContext, canvasId: string, proposed: ProposedGroup) {
  const authority = groupAuthority(context, canvasId, proposed.key);
  if (!authority) return { group: proposed, retired: false };
  return { group: { ...proposed, name: authority.name, definition: authority.definition,
    parent: parentScope(context, canvasId, authority.parentKey) }, retired: authority.retired };
}
