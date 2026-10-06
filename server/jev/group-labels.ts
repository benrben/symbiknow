import type { CanvasDocument } from '../../shared/types.js';
import type { JevVocabularyTerm } from '../../shared/jev-types.js';
import { groupPath, normalizedGroup } from '../../shared/groups.js';
import { plainGroupName } from '../../shared/names.js';
import { JevWorkspaceFiles } from './workspace.js';

function visibleTerm(term: JevVocabularyTerm, allowedCanvasIds?: string[]): boolean {
  return !allowedCanvasIds || term.members.every(member => allowedCanvasIds.includes(member.canvasId));
}
function usedLabels(terms: JevVocabularyTerm[], used: Set<string>, allowedCanvasIds?: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const term of terms.filter(term => term.kind === 'group' && term.state === 'active' && visibleTerm(term, allowedCanvasIds))) {
    const key = normalizedGroup(term.groupKey);
    if (key && used.has(key)) labels[key] = plainGroupName(term.name);
  }
  return labels;
}
/** This optional projection never blocks primary knowledge when Reflex needs recovery. */
export async function groupLabels(root: string, canvas: CanvasDocument, allowedCanvasIds?: string[]): Promise<Record<string, string> | undefined> {
  const used = new Set(canvas.blocks.flatMap(block => block.group ? groupPath(block.group) : []));
  if (!used.size) return undefined;
  try {
    const state = await new JevWorkspaceFiles(root).read(canvas.workspaceId);
    const labels = usedLabels(state.vocabulary, used, allowedCanvasIds);
    return Object.keys(labels).length ? labels : undefined;
  } catch {
    console.warn('Symbi Reflex group labels need recovery; native document groups remain available.');
    return undefined;
  }
}
