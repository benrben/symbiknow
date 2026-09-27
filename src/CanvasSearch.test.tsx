// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SearchHit } from '../shared/types';
import { CanvasSearch } from './CanvasSearch';

const hits: SearchHit[] = [
  { canvasId: 'project', canvasName: 'project', blockId: 'api-plan', title: 'API plan', excerpt: 'The api endpoints are listed here.', group: 'area:backend', tags: ['api'], kind: 'markdown', matchIn: 'title' },
  { canvasId: 'project', canvasName: 'project', blockId: 'auth', title: 'Auth decisions', excerpt: 'Use the API token.', group: 'area:backend', tags: ['security'], kind: 'markdown', matchIn: 'body' },
  { canvasId: 'research', canvasName: 'Jev research', blockId: 'remote', title: 'API review', excerpt: 'Review the api design.', group: 'area:research', tags: ['api'], kind: 'mdx', matchIn: 'title' },
];

afterEach(cleanup);

describe('CanvasSearch', () => {
  it('highlights matching text, filters metadata, and navigates local results with the keyboard', () => {
    const onReveal = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={onReveal} onEdit={vi.fn()}/>);
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    expect(within(search).getAllByText('API', { selector: 'mark' }).length).toBeGreaterThan(0);
    expect(within(search).getAllByText('Title match')).toHaveLength(2);
    fireEvent.change(within(search).getByLabelText('Filter by tag'), { target: { value: 'security' } });
    expect(within(search).getAllByRole('option').filter(item => item.getAttribute('aria-selected') !== null)).toHaveLength(1);
    fireEvent.keyDown(within(search).getByRole('textbox', { name: 'Search every Markdown file' }), { key: 'Enter' });
    expect(onReveal).toHaveBeenCalledWith(hits[1]);
  });

  it('shows the destination before crossing canvases', () => {
    const onReveal = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={onReveal} onEdit={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Show API review on canvas' }));
    expect(screen.getByRole('dialog', { name: 'Switch canvas' }).textContent).toContain('Jev research');
    expect(onReveal).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch canvas' })).getByRole('button', { name: 'Switch canvas' }));
    expect(onReveal).toHaveBeenCalledWith(hits[2]);
  });
});
