import { groupLabel } from '../shared/groups';

export function shortSuggestionTitle(title: string): string {
  if (title.length <= 42) return title;
  const lastCodeUnit = title.charCodeAt(38);
  const end = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? 38 : 39;
  return `${title.slice(0, end).trimEnd()}…`;
}

export function suggestionGroupTitle(group: string): string {
  return group === '__ungrouped' ? 'Ungrouped' : groupLabel(group);
}
