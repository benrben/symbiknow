// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { BrowseGroups } from './BrowseGroups';

function block(id: string, title: string, group?: string): CanvasBlock {
  return { id, title, group, file: `${id}.md`, kind: 'markdown', content: '', x: 0, y: 0, width: 400, height: 300, links: [] };
}

const canvas: CanvasDocument = { id: 'roadmap', name: 'Roadmap', workspaceId: 'team', blocks: [
  block('alpha', 'Alpha notes', 'custom:launch'), block('beta', 'Beta checklist', 'custom:launch'),
  block('qa', 'QA plan', 'custom:launch/quality'), block('loose', 'Loose note'),
] };

afterEach(cleanup);

describe('BrowseGroups', () => {
  it('lists saved groups and ungrouped documents and opens the chosen document', () => {
    const onOpenBlock = vi.fn();
    render(<BrowseGroups canvas={canvas} onOpenBlock={onOpenBlock} onClose={vi.fn()}/>);
    const launch = screen.getByRole('region', { name: 'Launch' });
    expect(within(launch).getByRole('heading', { name: 'Launch 2 documents' })).toBeTruthy();
    expect(within(launch).getAllByRole('button').map(button => button.textContent)).toEqual(['Alpha notesmarkdown', 'Beta checklistmarkdown']);
    expect(screen.getByRole('region', { name: 'Launch / Quality' }).textContent).toContain('QA plan');
    expect(screen.getByRole('region', { name: 'Ungrouped' }).textContent).toContain('Loose note');
    fireEvent.click(screen.getByRole('button', { name: 'Open QA plan' }));
    expect(onOpenBlock).toHaveBeenCalledWith('qa');
  });

  it('closes by button or Escape', () => {
    const onClose = vi.fn();
    render(<BrowseGroups canvas={canvas} onOpenBlock={vi.fn()} onClose={onClose}/>);
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Browse groups' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close browse groups' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows a clear empty state', () => {
    render(<BrowseGroups canvas={{ ...canvas, blocks: [] }} onOpenBlock={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.getByText('No documents in this canvas yet.')).toBeTruthy();
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });
});
