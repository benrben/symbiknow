import { useState } from 'react';
import type { CanvasBlock } from '../shared/types';
import type { CanvasInspectorProps } from './canvas-inspector-types';

type ActionProps = Pick<CanvasInspectorProps, 'selected' | 'onUpdateBlock' | 'onError'>;
export function useInspectorActions({ selected, onUpdateBlock, onError }: ActionProps) {
  const [group, setGroup] = useState('');
  const [tag, setTag] = useState('');
  const [target, setTarget] = useState('');
  async function updateAll(patch: (block: CanvasBlock) => Partial<CanvasBlock>) {
    try { await Promise.all(selected.map(block => onUpdateBlock(block.id, patch(block)))); }
    catch (error) { onError(error instanceof Error ? `Could not update selection: ${error.message}` : 'Could not update selection.'); }
  }
  function applyGroup() {
    const value = group.trim();
    if (!value) return;
    const key = value.includes(':') ? value : `custom:${value.toLowerCase().replace(/[^a-z0-9/_-]+/g, '_')}`;
    void updateAll(() => ({ group: key }));
    setGroup('');
  }
  function applyTag() {
    const value = tag.trim();
    if (!value) return;
    void updateAll(block => ({ tags: [...new Set([...(block.tags ?? []), value])] }));
    setTag('');
  }
  function connectTarget() {
    if (!target) return;
    void updateAll(block => ({ links: block.id === target ? block.links : [...new Set([...block.links, target])] }));
    setTarget('');
  }
  function connectTogether() {
    if (selected.length < 2) return;
    void updateAll(block => ({ links: [...new Set([...block.links, ...selected.filter(other => other.id !== block.id).map(other => other.id)])] }));
  }
  return { group, setGroup, tag, setTag, target, setTarget, applyGroup, applyTag, connectTarget, connectTogether };
}
export type InspectorActions = ReturnType<typeof useInspectorActions>;
