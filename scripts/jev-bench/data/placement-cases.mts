import { atlas, makeDoc, type Doc } from '../common.mts';
import { groups, alternates } from './placement-families.mts';
export { groups } from './placement-families.mts';
const offTopic: Doc[] = [
  makeDoc('offsite', 'Team offsite agenda', '# Team offsite agenda\n## Day one\nArrive at the lodge by 10:00. Morning hike, then lunch by the lake.\n## Day two\nWorkshops on team goals for next year, followed by dinner.\n## Travel\nCarpools leave from the office at 7:30.'),
  makeDoc('kitchen', 'Office kitchen rules', '# Office kitchen rules\n## Fridge\nLabel your food with your name and date. The fridge is emptied every Friday.\n## Coffee\nWhoever finishes the coffee makes a new pot.\n## Dishes\nLoad the dishwasher.'),
  makeDoc('spring', 'Spring marketing campaign', '# Spring marketing campaign\n## Goals\nGrow newsletter signups by 20% with a seasonal discount.\n## Channels\nInstagram, email, and two podcast sponsorships.\n## Budget\n12,000 euros.'),
];
export const fileCases = [...groups.flatMap((g) => g.members.map((id) => ({ doc: atlas[id], ok: alternates[id] ?? [g.key] }))), ...offTopic.map((doc) => ({ doc, ok: [] as string[] }))];
export const visibleGroups = (exclude: string) => groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== exclude) }));
export const canvases = [
  { id: '6f1c2a90-search', name: 'Search and AI', docs: ['search-and-brain-tools', 'symbi-reflex', 'reflex-internals', 'sdk-and-webmcp', 'assistant-and-research', 'chat-internals'] },
  { id: '8d3e5b11-collab', name: 'Collaboration and data', docs: ['safe-collaboration', 'document-operations', 'data-model', 'mcp-and-api', 'security-and-access'] },
  { id: '2a7f9c33-ui', name: 'Interface and brand', docs: ['brand-and-ui', 'canvas-ui'] },
  { id: '4b8d1e77-eng', name: 'Engineering', docs: ['operations', 'testing', 'errors', 'architecture', 'history', 'plan-status'] },
];
const homeOffTopic: Doc[] = [
  makeDoc('offsite', 'Team offsite agenda', '# Team offsite agenda\n## Day one\nArrive at the lodge by 10:00. Morning hike, then lunch by the lake.\n## Day two\nWorkshops on team goals for next year, followed by a dinner at a local restaurant.\n## Travel\nCarpools leave from the office at 7:30. Bring warm clothes.'),
  makeDoc('kitchen', 'Office kitchen rules', '# Office kitchen rules\n## Fridge\nLabel your food with your name and date. The fridge is emptied every Friday at 16:00.\n## Coffee\nWhoever finishes the coffee makes a new pot. Descale the machine monthly.\n## Dishes\nLoad the dishwasher; do not leave dishes in the sink.'),
  makeDoc('spring', 'Spring marketing campaign', '# Spring marketing campaign\n## Goals\nGrow newsletter signups by 20% through a seasonal discount campaign.\n## Channels\nInstagram, email newsletter, and two podcast sponsorships.\n## Budget\nTotal spend is 12,000 euros, split evenly across channels.'),
];
export type HomeCase = { doc: Doc; current: string; right: string | null };
export const homeCases: HomeCase[] = [];
canvases.forEach((c, ci) => c.docs.forEach((id, di) => {
  const wrong = canvases[(ci + 1 + di % 3) % canvases.length];
  homeCases.push({ doc: atlas[id], current: di % 2 === 0 ? c.id : wrong.id, right: c.id });
}));
homeOffTopic.forEach((doc, i) => homeCases.push({ doc, current: canvases[i].id, right: null }));
export const visibleCanvases = (exclude: string) => canvases.map((c) => ({ ...c, docs: c.docs.filter((d) => d !== exclude) }));
