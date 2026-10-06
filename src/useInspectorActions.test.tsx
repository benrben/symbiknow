// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { CanvasBlock } from '../shared/types';
import { useInspectorActions } from './useInspectorActions';

const block: CanvasBlock = { id: 'doc', title: 'Document', file: 'docs/doc.md', kind: 'markdown', content: '# Document', x: 0, y: 0, width: 320, height: 240, links: [] };
afterEach(cleanup);

describe('inspector action controller safety', () => {
  it('refuses an absent target or a selection too small for mutual connections', () => {
    const onUpdateBlock = vi.fn(async () => {}); const onError = vi.fn();
    const { result } = renderHook(() => useInspectorActions({ selected: [block], onUpdateBlock, onError }));
    act(() => { result.current.connectTarget(); result.current.connectTogether(); });
    expect(onUpdateBlock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.target).toBe('');
  });
});
