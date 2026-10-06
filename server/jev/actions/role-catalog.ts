import type { JevInputDocument } from './context.js';
import { sourcePassages } from './source-passages.js';

export interface DocumentRole { id: string; definition: string; aliases: string[]; examples: string[] }

/** Stable role IDs are saved in profiles; aliases only influence the bounded question shortlist. */
export const documentRoles: readonly DocumentRole[] = [
  { id: 'overview', definition: 'Introduces a subject and its purpose', aliases: ['overview', 'introduction'], examples: ['Project overview'] },
  { id: 'specification', definition: 'Defines required behavior or constraints', aliases: ['spec', 'requirements', 'contract'], examples: ['API specification'] },
  { id: 'decision', definition: 'Records an explicit choice and rationale', aliases: ['decision', 'adr', 'rationale'], examples: ['Architecture decision'] },
  { id: 'report', definition: 'Reports observed progress or results', aliases: ['report', 'status', 'results'], examples: ['Quarterly report'] },
  { id: 'instructions', definition: 'Explains how to carry out work', aliases: ['instructions', 'how to', 'steps'], examples: ['Deployment instructions'] },
  { id: 'runbook', definition: 'Operational steps for a repeatable event', aliases: ['runbook', 'operations', 'rollback'], examples: ['Rollback runbook'] },
  { id: 'checklist', definition: 'A list of checks or completion items', aliases: ['checklist', 'check off'], examples: ['Release checklist'] },
  { id: 'meeting_notes', definition: 'Records discussion, decisions, and action items', aliases: ['meeting', 'minutes', 'notes'], examples: ['Planning meeting notes'] },
  { id: 'reference', definition: 'Provides facts for later consultation', aliases: ['reference', 'glossary', 'catalog'], examples: ['Protocol reference'] },
  { id: 'proposal', definition: 'Recommends a future change for consideration', aliases: ['proposal', 'proposed', 'rfc'], examples: ['Migration proposal'] },
  { id: 'plan', definition: 'Sets intended work, sequence, or milestones', aliases: ['plan', 'roadmap', 'milestone'], examples: ['Release plan'] },
  { id: 'policy', definition: 'Sets rules or required conduct', aliases: ['policy', 'rule', 'compliance'], examples: ['Access policy'] },
  { id: 'research', definition: 'Explores evidence or alternatives', aliases: ['research', 'study', 'experiment'], examples: ['User research'] },
  { id: 'incident_report', definition: 'Records an incident and its observed effects', aliases: ['incident', 'outage', 'severity'], examples: ['Production incident report'] },
  { id: 'postmortem', definition: 'Analyzes causes and follow-up after an incident', aliases: ['postmortem', 'root cause', 'lessons learned'], examples: ['Outage postmortem'] },
  { id: 'tutorial', definition: 'Teaches a topic through worked steps', aliases: ['tutorial', 'walkthrough', 'lesson'], examples: ['Getting started tutorial'] },
  { id: 'faq', definition: 'Answers recurring questions', aliases: ['faq', 'frequently asked', 'q&a'], examples: ['Onboarding FAQ'] },
  { id: 'changelog', definition: 'Lists changes across versions or dates', aliases: ['changelog', 'release notes', 'changes'], examples: ['Version changelog'] },
];

const baseline = new Set(['overview', 'specification', 'decision', 'report', 'instructions', 'reference']);

export function roleShortlist(document: JevInputDocument, limit = 10): Record<string, string> {
  const text = `${document.block.title}\n${sourcePassages(document.block.content).slice(0, 12).map(item => item.text).join('\n')}`.toLocaleLowerCase();
  const ranked = documentRoles.map((role, order) => ({ role, order,
    score: [role.id.replace(/_/g, ' '), ...role.aliases].reduce((score, phrase) =>
      score + Number(text.includes(phrase.toLocaleLowerCase())), 0) }));
  ranked.sort((left, right) => right.score - left.score || Number(baseline.has(right.role.id)) - Number(baseline.has(left.role.id)) || left.order - right.order);
  return { ...Object.fromEntries(ranked.slice(0, limit).map(({ role }) =>
    [role.id, `${role.definition}. Example: ${role.examples[0]}`])),
    none: 'No listed role is sufficiently supported',
    unknown: 'Supplied passages do not contain enough evidence to determine the role' };
}
