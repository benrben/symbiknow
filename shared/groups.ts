import type { DocumentLane, GroupBy } from './types.js';
import { workAreaLabel } from './work-areas.js';

export const laneNames: Record<DocumentLane, string> = {
  overview: 'Overview', work: 'Active work', reference: 'Reference', followup: 'Follow-up',
};
export const lanes = Object.keys(laneNames) as DocumentLane[];

const prefixes: Record<GroupBy, string> = { lane: 'lane', work_area: 'area', purpose: 'purpose' };
const keyPattern = /^(lane|area|purpose|custom):[a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,7}$/;

export const groupByLabels: Record<GroupBy, string> = { work_area: 'Work area', purpose: 'Purpose', lane: 'Reading lane' };

export function groupKey(groupBy: GroupBy, value: string): string {
  return `${prefixes[groupBy]}:${value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64) || 'other'}`;
}

/** Older canvases saved bare lane names such as `work`. */
export function normalizedGroup(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return lanes.includes(key as DocumentLane) ? `lane:${key}` : key;
}

export function validGroupKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 256 && (keyPattern.test(key) || lanes.includes(key as DocumentLane));
}

/** The keys along a nested group's path, from the top-level group to itself. */
export function groupPath(key: string): string[] {
  const normalized = normalizedGroup(key) ?? key;
  const separator = normalized.indexOf(':');
  if (separator < 0) return [normalized];
  const prefix = normalized.slice(0, separator + 1);
  const segments = normalized.slice(separator + 1).split('/');
  return segments.map((_, index) => prefix + segments.slice(0, index + 1).join('/'));
}

export function groupAncestors(key: string): string[] {
  return groupPath(key).slice(0, -1);
}

export function groupParent(key: string): string | undefined {
  return groupAncestors(key).at(-1);
}

export function groupLabel(key: string): string {
  const normalized = normalizedGroup(key) ?? key;
  const [prefix, value = ''] = normalized.split(':');
  const segment = value.split('/').at(-1) || prefix;
  if (prefix === 'lane' && !value.includes('/')) return laneNames[segment as DocumentLane] ?? segment;
  if (segment === 'other') return 'Other';
  const words = prefix === 'area' && !value.includes('/') ? workAreaLabel(segment) : segment.replaceAll(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Stable color slot 0–7 for a group. Lanes keep their original colors. */
export function groupTone(key: string): number {
  const normalized = groupPath(key)[0];
  const lane = lanes.indexOf(normalized.replace(/^lane:/, '') as DocumentLane);
  if (normalized.startsWith('lane:') && lane >= 0) return lane;
  return [...normalized].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7) % 8;
}
