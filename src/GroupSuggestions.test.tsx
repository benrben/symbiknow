// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { BlockPosition } from './Canvas';
import { GroupSuggestions } from './GroupSuggestions';

const blocks: CanvasBlock[] = [
  { id: 'a', title: 'API plan', file: 'a.md', kind: 'markdown', content: '# API', x: 10, y: 20, width: 300, height: 220, links: [], tags: ['api'] },
  { id: 'b', title: 'Endpoint list', file: 'b.md', kind: 'markdown', content: '# Endpoints', x: 350, y: 20, width: 300, height: 220, links: [], tags: ['api'] },
  { id: 'c', title: 'Team notes', file: 'c.md', kind: 'markdown', content: '# Team', x: 690, y: 20, width: 300, height: 220, links: [] },
];
const canvas: CanvasDocument = { id: 'project', name: 'project', workspaceId: 'team', blocks };

afterEach(cleanup);

describe('GroupSuggestions', () => {
  it('previews tag groups, asks about ungrouped cards, applies positions, and undoes them', async () => {
    const onPreview = vi.fn();
    let current = structuredClone(canvas);
    const onApply = vi.fn(async (positions: BlockPosition[]) => {
      current = { ...current, blocks: current.blocks.map(block => {
        const position = positions.find(item => item.blockId === block.id);
        return position ? { ...block, ...position, group: position.group ?? undefined } : block;
      }) };
    });
    const view = render(<GroupSuggestions canvas={current} hasApiKey={false} onOpenSettings={vi.fn()} onApply={onApply} onClose={vi.fn()} onPreview={onPreview}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'By tags' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show preview on canvas' }));
    expect(onPreview).toHaveBeenCalledWith({ a: 'custom:tags/api', b: 'custom:tags/api' });
    expect(screen.getByText(/Nothing has been saved/)).toBeTruthy();
    expect(screen.getByText('Where should these documents go?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept grouping' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(screen.getByText(/Saved grouping for 2 documents/)).toBeTruthy();
    view.rerender(<GroupSuggestions canvas={current} hasApiKey={false} onOpenSettings={vi.fn()} onApply={onApply} onClose={vi.fn()} onPreview={onPreview}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Undo grouping' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Reverted grouping for 2 documents/)).toBeTruthy();
    expect(current.blocks.map(block => [block.x, block.y, block.group])).toEqual([[10, 20, undefined], [350, 20, undefined], [690, 20, undefined]]);
  });

  it('requests a Jev key for AI topic suggestions', () => {
    const onOpenSettings = vi.fn();
    render(<GroupSuggestions canvas={canvas} hasApiKey={false} onOpenSettings={onOpenSettings} onApply={vi.fn()} onClose={vi.fn()} onPreview={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Jev for groups' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('TypeSafe Jev');
  });
});
