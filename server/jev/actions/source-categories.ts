import type { JevPassage } from '../../../shared/jev-types.js';
import type { JevInputDocument } from './context.js';
import { plainGroupName } from '../../../shared/names.js';
import { sourcePassages } from './source-passages.js';

export interface SharedSourceCategory { name: string; sources: JevInputDocument[]; origins: JevPassage[] }
type CategoryPassage = { name: string; origin: JevPassage };

function categoryPassages(document: JevInputDocument): CategoryPassage[] {
  const found = new Map<string, CategoryPassage>();
  for (const passage of sourcePassages(document.block.content).slice(0, 12)) {
    if (!passage.text.includes('·')) continue;
    const name = plainGroupName(passage.text.split('·')[0]);
    if (!usableName(name)) continue;
    const key = name.toLocaleLowerCase();
    if (found.has(key)) continue;
    found.set(key, { name, origin: { source: document.snapshot, start: passage.start, end: passage.end, quote: passage.quote } });
  }
  return [...found.values()];
}
function usableName(name: string): boolean { return name.length >= 2 && name.length <= 40; }
function localSource(document: JevInputDocument, member: JevInputDocument): boolean {
  return document.canvasId === member.canvasId && document.snapshot.workspaceId === member.snapshot.workspaceId
    && !document.block.archived && !document.block.processingExcluded;
}
function appendCategory(categories: Map<string, SharedSourceCategory>, document: JevInputDocument, passage: CategoryPassage): void {
  const key = passage.name.toLocaleLowerCase();
  const category = categories.get(key) ?? { name: passage.name, sources: [], origins: [] };
  category.sources.push(document); category.origins.push(passage.origin); categories.set(key, category);
}
/** Repeated visible category captions nominate a topic; provider confidence and each member's own purpose still authorize filing. */
export function sharedSourceCategories(documents: JevInputDocument[], member: JevInputDocument): SharedSourceCategory[] {
  const categories = new Map<string, SharedSourceCategory>();
  for (const document of documents.filter(source => localSource(source, member))) {
    for (const passage of categoryPassages(document)) appendCategory(categories, document, passage);
  }
  return [...categories.values()].filter(category => category.sources.length > 1
    && category.sources.some(source => source.block.id === member.block.id))
    .sort((left, right) => right.sources.length - left.sources.length);
}
