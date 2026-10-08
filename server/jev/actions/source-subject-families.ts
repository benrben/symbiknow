import { plainGroupName } from '../../../shared/names.js';
import { membershipGroupKey } from './groups.js';
import { normalizedGroup } from '../../../shared/groups.js';
import type { ProposedGroup } from './group-topics.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { sourceSubjects, type SourceSubject } from './source-categories.js';
import { sourcePassages } from './source-passages.js';

type SubjectSource = { document: JevInputDocument; subject: SourceSubject };
type FamilyPhrase = { name: string; display: string; words: number; priority: number };
type Family = FamilyPhrase & { displayOrder: string; sources: Map<string, SubjectSource>; agreements: Map<string, number> };
// Grammatical and document-role words cannot supply a reusable subject by themselves.
const modifiers = new Set('a an and are as at be by for from how in into is it its of on or that the their this to use was were what which with internals internal overview guide guides checklist checklists system systems item items record records reference references handbook manual manuals summary summaries introduction introductory chapter chapters section sections notes note verifies validates ranks requires provides contains issues issued issuing records recorded supports uses runs running before after must can should need will without under between only also every each one other when where why allows include includes included does makes has have been being within using through then during than rather more most'.split(' ').map(normalizedWord));
function normalizedWord(word: string): string {
  return word.normalize('NFKC').toLocaleLowerCase();
}
function boundedPhraseName(name: string): boolean { return name.length >= 2 && name.length <= 80; }
function subjectPhrases(name: string): Array<{ name: string; display: string; words: number }> {
  const original = name.match(/[\p{L}][\p{L}\p{N}]*/gu) ?? [];
  const words = original.map(normalizedWord);
  const phrases: Array<{ name: string; display: string; words: number }> = [];
  for (let length = 1; length <= Math.min(3, words.length); length++) {
    for (let start = 0; start + length <= words.length; start++) {
      const selected = words.slice(start, start + length);
      if (selected.some(word => modifiers.has(word))) continue;
      const name = selected.join(' ');
      if (!boundedPhraseName(name)) continue;
      phrases.push({ name, display: original.slice(start, start + length).join(' '), words: length });
    }
  }
  return phrases;
}
function subjectPriority(source: SubjectSource): number {
  const heading = sourcePassages(source.document.block.content).find(passage => passage.headingLevel === 1);
  return Number(plainGroupName(heading?.text ?? '') !== source.subject.name);
}
function appendPhrase(families: Map<string, Family>, source: SubjectSource, phrase: FamilyPhrase): void {
  const displayOrder = `${phrase.priority}:${source.document.canvasId}:${source.document.block.id}:${phrase.display}`;
  const family = families.get(phrase.name) ?? { ...phrase, displayOrder,
    sources: new Map<string, SubjectSource>(), agreements: new Map<string, number>() };
  if (displayOrder < family.displayOrder) { family.display = phrase.display; family.displayOrder = displayOrder; }
  family.priority = Math.min(family.priority, phrase.priority);
  const id = source.document.block.id;
  family.agreements.set(id, Math.min(family.agreements.get(id) ?? 2, phrase.priority));
  if (!family.sources.has(id)) family.sources.set(id, source);
  families.set(phrase.name, family);
}
function appendSubject(families: Map<string, Family>, source: SubjectSource): void {
  const priority = subjectPriority(source);
  const names = subjectPhrases(source.subject.name).map(phrase => ({ ...phrase, priority }));
  const body = source.subject.bodyEvidence.slice(0, 2).flatMap(evidence => sourcePassages(evidence.quote)
    .flatMap(passage => subjectPhrases(passage.text.slice(0, 600)))).map(phrase => ({ ...phrase, priority: 2 }));
  for (const phrase of [...names, ...body]) appendPhrase(families, source, phrase);
}
function familySpecificity(family: Family, corpusSize: number): number {
  return Math.log((corpusSize + 1) / (family.sources.size + 1));
}
function compareFamilies(left: Family, right: Family, member: JevInputDocument, corpusSize: number): number {
  return left.agreements.get(member.block.id)! - right.agreements.get(member.block.id)!
    || familySpecificity(right, corpusSize) - familySpecificity(left, corpusSize)
    || right.words - left.words || left.name.localeCompare(right.name);
}
function familyCandidates(context: JevEvaluationContext, member: JevInputDocument): Family[] {
  const families = new Map<string, Family>();
  const documents = context.documents.filter(document => familySource(document, member));
  for (const document of documents) for (const subject of sourceSubjects(context, document)) appendSubject(families, { document, subject });
  return [...families.values()].filter(family => family.sources.size >= 2 && family.sources.has(member.block.id))
    .filter(family => membershipGroupKey(family.name) !== normalizedGroup(member.block.group))
    .sort((left, right) => compareFamilies(left, right, member, documents.length));
}
function familySource(document: JevInputDocument, member: JevInputDocument): boolean {
  return document.canvasId === member.canvasId && document.snapshot.workspaceId === member.snapshot.workspaceId
    && !document.block.archived && !document.block.processingExcluded;
}
function familyGroup(family: Family, member: JevInputDocument): ProposedGroup {
  const own = family.sources.get(member.block.id)!;
  const peers = [...family.sources.values()].filter(source => source.document.block.id !== member.block.id)
    .sort((left, right) => left.document.block.id.localeCompare(right.document.block.id)).slice(0, 4);
  return { name: plainGroupName(family.display), key: membershipGroupKey(family.name), nomination: 'source_family',
    origins: own.subject.origins, candidatePeers: peers.map(peer => peer.document.snapshot),
    subjectContext: peers.map(peer => ({ name: peer.subject.name, passages: peer.subject.origins.slice(0, 2), contextOnly: true })) };
}
/** Member subject agreement and corpus specificity rank nominations; independent own and peer purpose checks authorize them. */
export function sourceSubjectFamilies(context: JevEvaluationContext, member: JevInputDocument): ProposedGroup[] {
  return familyCandidates(context, member).slice(0, 8).map(family => familyGroup(family, member));
}
