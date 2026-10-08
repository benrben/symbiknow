import { atlas, makeDoc, type Doc } from './common.mts';
import type { JevInputDocument } from '../../server/jev/actions/context.ts';
import type { Pair } from '../../server/jev/actions/graph.ts';
import { heldoutDuplicates, heldoutLinks } from './graph-heldout.mts';
export type DuplicateTruth = 'copy' | 'older_version' | 'distinct';
export type DuplicateCase = { pair: Pair; truth: DuplicateTruth; name: string; heldout: boolean };
export type LinkCase = { pair: Pair; truth: boolean; name: string; heldout: boolean };
const DUPLICATE_HYPOTHESIS = 'source and target record substantially the same knowledge or work without a meaningful distinct update';
const LINK_HYPOTHESIS = 'source and target have a useful, evidence-backed directional relationship';
function pair(source: Doc, target: Doc, hypothesis: string): Pair {
  return { source: source as JevInputDocument, target: target as JevInputDocument, hypothesis };
}
const older = (id: string, title: string) => {
  const body = atlas[id].block.content.replace(/^#\s+.+$/m, `# ${title}`);
  const cut = body.lastIndexOf('\n## ');
  return makeDoc(`${id}-old`, title, body.slice(0, cut > 0 ? cut : body.length).replace('\n## ', '\nThis page was drafted before the latest review.\n\n## '));
};
const copies = ['operations', 'data-model', 'safe-collaboration', 'canvas-ui', 'assistant-and-research', 'security-and-access'];
const titles = ['Running SymbiKnow', 'Storage model', 'Editing safely together', 'Canvas interface guide', 'Chat assistant and research board', 'Access and security notes'];
const distinct = [['symbi-reflex', 'reflex-internals'], ['safe-collaboration', 'document-operations'], ['mcp-and-api', 'sdk-and-webmcp'],
  ['assistant-and-research', 'chat-internals'], ['architecture', 'data-model'], ['search-and-brain-tools', 'symbi-reflex'],
  ['brand-and-ui', 'errors'], ['testing', 'canvas-ui'], ['history', 'security-and-access']];
export const duplicateCases: DuplicateCase[] = [
  ...copies.map(id => ({ pair: pair(makeDoc(`${id}-copy`, `${atlas[id].block.title} (copy)`, atlas[id].block.content.replace(/^#\s+(.+)$/m, '# $1 (copy)')), atlas[id], DUPLICATE_HYPOTHESIS), truth: 'copy' as const, name: `copy:${id}`, heldout: false })),
  ...copies.map((id, i) => ({ pair: pair(older(id, titles[i]), atlas[id], DUPLICATE_HYPOTHESIS), truth: 'older_version' as const, name: `older:${id}`, heldout: false })),
  ...distinct.map(([s, t]) => ({ pair: pair(atlas[s], atlas[t], DUPLICATE_HYPOTHESIS), truth: 'distinct' as const, name: `distinct:${s}~${t}`, heldout: false })),
];
const related = [['reflex-internals', 'symbi-reflex'], ['assistant-and-research', 'chat-internals'], ['document-operations', 'safe-collaboration'],
  ['sdk-and-webmcp', 'mcp-and-api'], ['security-and-access', 'sdk-and-webmcp'], ['testing', 'operations'],
  ['chat-internals', 'assistant-and-research'], ['symbi-reflex', 'reflex-internals']];
const unrelated = [['brand-and-ui', 'testing'], ['canvas-ui', 'security-and-access'], ['data-model', 'brand-and-ui'], ['operations', 'brand-and-ui'],
  ['history', 'canvas-ui'], ['testing', 'brand-and-ui'], ['errors', 'canvas-ui'], ['safe-collaboration', 'brand-and-ui'],
  ['history', 'brand-and-ui'], ['brand-and-ui', 'data-model'], ['canvas-ui', 'operations'], ['sdk-and-webmcp', 'brand-and-ui'], ['plan-status', 'canvas-ui'], ['errors', 'brand-and-ui']];
export const linkCases: LinkCase[] = [
  ...related.map(([s, t]) => ({ pair: pair(atlas[s], atlas[t], LINK_HYPOTHESIS), truth: true, name: `${s}->${t}`, heldout: false })),
  ...unrelated.map(([s, t]) => ({ pair: pair(atlas[s], atlas[t], LINK_HYPOTHESIS), truth: false, name: `${s}->${t}`, heldout: false })),
];
export const heldoutDuplicateCases: DuplicateCase[] = heldoutDuplicates.map(({ source, target, truth, name }) => ({
  pair: pair(makeDoc(`heldout-${name}-source`, source.title, source.body), makeDoc(`heldout-${name}-target`, target.title, target.body), DUPLICATE_HYPOTHESIS),
  truth, name: `heldout:${name}`, heldout: true,
}));
export const heldoutLinkCases: LinkCase[] = heldoutLinks.map(({ source, target, truth, name }) => ({
  pair: pair(makeDoc(`heldout-${name}-source`, source.title, source.body), makeDoc(`heldout-${name}-target`, target.title, target.body), LINK_HYPOTHESIS),
  truth, name: `heldout:${name}`, heldout: true,
}));
