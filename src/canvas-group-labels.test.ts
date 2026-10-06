import { expect, it } from 'vitest';
import { groupDisplayLabel, groupDisplayPath } from './canvas-group-labels';

it('shows preserved human group names without duplicating the parent in a subgroup path', () => {
  const labels = { 'custom:topic_a': 'מוצר', 'custom:topic_a/topic_b': 'מוצר / מסירה' };
  expect(groupDisplayLabel('custom:topic_a', labels)).toBe('מוצר');
  expect(groupDisplayLabel('custom:topic_a/topic_b', labels)).toBe('מסירה');
  expect(groupDisplayPath('custom:topic_a/topic_b', labels)).toBe('מוצר / מסירה');
  expect(groupDisplayPath('custom:release/staged')).toBe('Release / Staged');
  expect(groupDisplayLabel('custom:release', { 'custom:release': '' })).toBe('Release');
});
