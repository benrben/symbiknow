// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SearchHit } from '../shared/types';
import { CanvasSearch } from './CanvasSearch';

const hits: SearchHit[] = [
  { canvasId: 'project', canvasName: 'project', blockId: 'api-plan', title: 'API plan', excerpt: 'The api endpoints are listed here.', group: 'area:backend', tags: ['api'], kind: 'markdown', matchIn: 'title',
    evidence: { claim: 'api', passage: 'The api endpoints are listed here.', passageKind: 'exact', canvasId: 'project', documentId: 'api-plan', contentHash: 'abc123', checkedAt: '2026-09-28T10:00:00Z', navigation: { kind: 'document', canvasId: 'project', blockId: 'api-plan' } } },
  { canvasId: 'project', canvasName: 'project', blockId: 'auth', title: 'Auth decisions', excerpt: 'Use the API token.', group: 'area:backend', tags: ['security'], kind: 'markdown', matchIn: 'body',
    evidence: { claim: 'api', passage: 'Use the API token.', passageKind: 'approximation', passageLabel: 'Approximate source context; open the document to verify the claim.', canvasId: 'project', documentId: 'auth', checkedAt: '2026-09-28T10:00:00Z', navigation: { kind: 'document', canvasId: 'project', blockId: 'auth' } } },
  { canvasId: 'research', canvasName: 'Jev research', blockId: 'remote', title: 'API review', excerpt: 'Review the api design.', group: 'area:research', tags: ['api'], kind: 'mdx', matchIn: 'title',
    evidence: { claim: 'api', passage: 'Review the api design.', passageKind: 'exact', canvasId: 'research', documentId: 'remote', checkedAt: '2026-09-28T10:00:00Z', navigation: { kind: 'document', canvasId: 'research', blockId: 'remote' } } },
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

  it('counts and traverses every visible result, including another canvas', () => {
    const onReveal = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={onReveal} onEdit={vi.fn()}/>);
    const search = screen.getByRole('dialog', { name: 'Search documents' });
    const input = within(search).getByRole('textbox', { name: 'Search every Markdown file' });
    expect(within(search).getByText('1 of 3')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(search).getByText('3 of 3')).toBeTruthy();
    expect(within(search).getByRole('option', { name: /API review/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Switch canvas' })).toBeTruthy();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('offers retry for a network error without showing zero matches', () => {
    const onRetry = vi.fn();
    render(<CanvasSearch query="api" hits={[]} loading={false} error="Server unavailable" onRetry={onRetry} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={vi.fn()} onEdit={vi.fn()}/>);
    expect(screen.getByRole('alert').textContent).toContain('Server unavailable');
    expect(screen.queryByText('No matching documents.')).toBeNull();
    expect(screen.queryByText('0 of 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps loading distinct from an empty search result', () => {
    render(<CanvasSearch query="api" hits={[]} loading currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={vi.fn()} onEdit={vi.fn()}/>);
    expect(screen.getByRole('status').textContent).toContain('Results are loading');
    expect(screen.queryByText('No matching documents.')).toBeNull();
    expect(screen.queryByText('0 of 0')).toBeNull();
  });

  it('warns when loaded content has changed since evidence was checked', () => {
    const onOpenEvidence = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" currentContentHashes={{ 'project:api-plan': 'new-hash' }} onQuery={vi.fn()} onClose={vi.fn()} onReveal={vi.fn()} onEdit={vi.fn()} onOpenEvidence={onOpenEvidence}/>);
    const result = screen.getByRole('option', { name: /API plan/ });
    expect(within(result).getByText(/Document changed since this search/)).toBeTruthy();
    fireEvent.click(within(result).getByRole('button', { name: 'Read current document API plan' }));
    expect(onOpenEvidence).toHaveBeenCalledWith(hits[0]);
    expect(screen.getByRole('option', { name: /Auth decisions/ }).textContent).not.toContain('Document changed');
  });

  it('shows checked provenance and opens the cited passage', () => {
    const onOpenEvidence = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={vi.fn()} onEdit={vi.fn()} onOpenEvidence={onOpenEvidence}/>);
    const result = screen.getByRole('option', { name: /API plan/ });
    expect(within(result).getByText('Exact source passage')).toBeTruthy();
    expect(within(result).getByText(/Hash abc123/)).toBeTruthy();
    expect(screen.getByText('Approximate source context')).toBeTruthy();
    fireEvent.click(within(result).getByRole('button', { name: 'Read cited passage in API plan' }));
    expect(onOpenEvidence).toHaveBeenCalledWith(hits[0]);
  });

  it('confirms a canvas switch before opening evidence elsewhere', () => {
    const onOpenEvidence = vi.fn();
    render(<CanvasSearch query="api" hits={hits} loading={false} currentCanvasId="project" onQuery={vi.fn()} onClose={vi.fn()} onReveal={vi.fn()} onEdit={vi.fn()} onOpenEvidence={onOpenEvidence}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Read cited passage in API review' }));
    expect(onOpenEvidence).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: 'Switch canvas' });
    expect(confirm.textContent).toContain('Jev research');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Switch canvas' }));
    expect(onOpenEvidence).toHaveBeenCalledWith(hits[2]);
  });
});
