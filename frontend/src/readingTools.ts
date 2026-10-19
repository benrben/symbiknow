export function findTextMatches(text: string, query: string, limit = 500) {
  const term = query.trim();
  if (!term) return [];
  const pattern = new RegExp(
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const matches: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({ start: match.index!, end: match.index! + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}
export function boundedHistory<T extends { id: string }>(
  items: T[],
  entry: T,
  limit = 30,
) {
  return [entry, ...items.filter((item) => item.id !== entry.id)].slice(
    0,
    limit,
  );
}
