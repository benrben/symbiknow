import type { CanvasBlock } from '../../shared/types.js';

/** An unassigned field can acquire its first automatic group unless the user explicitly pinned it empty. */
export function automaticGroupingAllowed(block: Pick<CanvasBlock, 'group' | 'jevOwnership'>): boolean {
  const ownership = block.jevOwnership;
  return Boolean(ownership && !ownership.pins.includes('group') && (!block.group || ownership.managed.includes('group')));
}
