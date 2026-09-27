import { describe, expect, it } from 'vitest';
import { groupAncestors, groupLabel, groupParent, groupPath, groupTone, normalizedGroup, validGroupKey } from './groups';

describe('nested group keys', () => {
  it('preserves legacy lanes and labels top-level groups', () => {
    expect(normalizedGroup('work')).toBe('lane:work');
    expect(groupPath('work')).toEqual(['lane:work']);
    expect(groupLabel('work')).toBe('Active work');
    expect(groupLabel('area:developer_experience')).toBe('Developer experience');
    expect(groupLabel('purpose:other')).toBe('Other');
  });

  it('labels each nested segment and exposes its ancestors', () => {
    const key = 'custom:research/benchmarks/qwen';
    expect(validGroupKey(key)).toBe(true);
    expect(groupPath(key)).toEqual(['custom:research', 'custom:research/benchmarks', key]);
    expect(groupAncestors(key)).toEqual(['custom:research', 'custom:research/benchmarks']);
    expect(groupParent(key)).toBe('custom:research/benchmarks');
    expect(groupParent('custom:research')).toBeUndefined();
    expect(groupLabel('custom:research')).toBe('Research');
    expect(groupLabel('custom:research/model_benchmarks')).toBe('Model benchmarks');
    expect(groupLabel('area:platform/api_guides')).toBe('Api guides');
    expect(groupLabel('lane:work/next_steps')).toBe('Next steps');
    expect(groupTone(key)).toBe(groupTone('custom:research'));
    expect(groupTone('lane:work/next_steps')).toBe(groupTone('work'));
  });

  it('rejects empty or unsafe path segments and excessive depth', () => {
    for (const key of ['custom:', 'custom:/research', 'custom:research/', 'custom:research//qwen',
      'custom:research/../qwen', 'custom:research/White Space', 'unknown:research',
      `custom:${'a'.repeat(65)}`, `custom:${Array(9).fill('node').join('/')}`]) {
      expect(validGroupKey(key)).toBe(false);
    }
    expect(validGroupKey('lane:overview')).toBe(true);
    expect(validGroupKey('area:platform/api')).toBe(true);
    expect(validGroupKey('purpose:report/draft')).toBe(true);
  });
});
