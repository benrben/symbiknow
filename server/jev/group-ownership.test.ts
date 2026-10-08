import { expect, it } from 'vitest';
import { automaticGroupingAllowed } from './group-ownership.js';
import { changedJevStamp, initializeJevStamp } from './stamps.js';

function unassigned() {
  return { ...initializeJevStamp({ id: 'source', title: 'Authentication', content: '# Authentication', kind: 'markdown',
    file: 'docs/source.md', x: 0, y: 0, width: 400, height: 300, links: [] }),
  jevOwnership: { managed: [] as string[], pins: [] as string[], removedLabels: [], removedLinks: [] } };
}

it('acquires only the first unpinned automatic group while leaving other field ownership unchanged', () => {
  const before = unassigned();
  expect(automaticGroupingAllowed(before)).toBe(true);
  const after = changedJevStamp(before, { ...before, group: 'custom:authentication' }, { mutationId: 'auto', managed: true });
  expect(after.jevOwnership).toEqual({ ...before.jevOwnership, managed: ['group'] });
  expect(after.sourceGeneration).toBe(before.sourceGeneration);
  expect(after.metadataRevision).toBe(before.metadataRevision! + 1);
  expect(automaticGroupingAllowed(after)).toBe(true);
});

it.each(['pinned-empty', 'manual-existing', 'manual-write', 'still-empty'] as const)
  ('does not acquire automatic ownership for %s', boundary => {
    const before = unassigned();
    if (boundary === 'pinned-empty') before.jevOwnership.pins.push('group');
    const source = boundary === 'manual-existing' ? { ...before, group: 'custom:manual' } : before;
    const next = boundary === 'still-empty' ? { ...source } : { ...source, group: 'custom:authentication' };
    const after = changedJevStamp(source, next, { mutationId: 'write', managed: boundary !== 'manual-write' });
    expect(after.jevOwnership!.managed).toEqual([]);
    if (boundary === 'pinned-empty' || boundary === 'manual-write') expect(after.jevOwnership!.pins).toContain('group');
    if (boundary === 'manual-existing' || boundary === 'pinned-empty') expect(automaticGroupingAllowed(source)).toBe(false);
  });
