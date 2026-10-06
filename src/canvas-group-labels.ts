import { groupLabel, groupPath, normalizedGroup } from '../shared/groups';

export function groupDisplayLabel(key: string, labels?: Record<string, string>): string {
  const label = labels?.[normalizedGroup(key) ?? key];
  if (!label) return groupLabel(key);
  return groupPath(key).length > 1 ? label.split(/\s*\/\s*/).at(-1)! : label;
}

export function groupDisplayPath(key: string, labels?: Record<string, string>): string {
  return groupPath(key).map(path => groupDisplayLabel(path, labels)).join(' / ');
}
