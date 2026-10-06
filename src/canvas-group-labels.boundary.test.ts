import { expect, it } from 'vitest';
import { groupDisplayLabel, groupDisplayPath } from './canvas-group-labels';

it('keeps an explicit unassigned label while normalizing legacy lane keys and nested native paths', () => {
  expect(groupDisplayLabel('', { '': 'Unassigned' })).toBe('Unassigned');
  expect(groupDisplayLabel('work', { 'lane:work': 'Delivery' })).toBe('Delivery');
  expect(groupDisplayPath('custom:delivery/verification', {
    'custom:delivery': 'מסירה', 'custom:delivery/verification': 'מסירה / בדיקה',
  })).toBe('מסירה / בדיקה');
});
