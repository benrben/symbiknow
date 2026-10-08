export type DocumentSection = { title: string; offset: number };

/** Section titles in source order, shared by search and Jev action outlines. */
export function documentSections(content: string): DocumentSection[] {
  return [...content.matchAll(/^#{2,3}[ \t]+(.+)$|<h[23][^>]*>([\s\S]*?)<\/h[23]>/gim)]
    .map(match => ({ title: (match[1] ?? match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(), offset: match.index }))
    .filter(section => section.title);
}

export function sectionNames(content: string, limit = 30): string[] {
  return documentSections(content).slice(0, limit).map(section => section.title);
}
