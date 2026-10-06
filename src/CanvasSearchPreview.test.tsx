// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, SearchHit } from '../shared/types';
import { CanvasSearchPreview } from './CanvasSearchPreview';
import { useDocumentContent } from './useDocumentContent';

const block: CanvasBlock = { id: 'architecture', title: 'Atlas: Architecture', kind: 'markdown', file: 'docs/architecture.md',
  content: '# Architecture\n\nThe **canvas** stores positions.', x: 0, y: 0, width: 400, height: 300, links: [] };
const hit = { canvasId: 'projects', canvasName: 'Projects', blockId: block.id, title: block.title,
  excerpt: 'The canvas stores positions.', kind: 'markdown', tags: [], matchIn: 'body',
  evidence: { claim: 'Canvas stores positions', passage: 'The canvas stores positions.', passageKind: 'exact',
    canvasId: 'projects', documentId: block.id, checkedAt: '2026-10-06T00:00:00Z',
    navigation: { kind: 'document', canvasId: 'projects', blockId: block.id } },
} satisfies SearchHit;
vi.mock('./useDocumentContent', () => ({ useDocumentContent: vi.fn() }));
beforeEach(() => {
  vi.mocked(useDocumentContent).mockReturnValue({ block, loading: false, error: '', retry: vi.fn() });
});
afterEach(cleanup);

it('previews saved Markdown without changing its source and keeps source navigation available', () => {
  const request = vi.fn();
  render(<CanvasSearchPreview hit={hit} request={request} evidenceEnabled/>);
  expect(screen.getByRole('heading', { name: 'Atlas: Architecture', level: 3 })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Architecture', level: 1 })).toBeNull();
  expect(screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'The canvas stores positions.')).toBeTruthy();
  expect(block.content).toBe('# Architecture\n\nThe **canvas** stores positions.');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('docs/architecture.md')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'The canvas stores positions.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
  expect(request).toHaveBeenCalledWith(hit, 'evidence');
});

it('renders a Markdown document with front matter and no title heading', () => {
  const note = { ...block, title: 'Notes', content: '---\ntags: [design]\n---\nThe first paragraph is the content.' };
  vi.mocked(useDocumentContent).mockReturnValue({ block: note, loading: false, error: '', retry: vi.fn() });
  render(<CanvasSearchPreview hit={{ ...hit, title: note.title }} request={vi.fn()} evidenceEnabled/>);
  expect(screen.getByRole('heading', { name: 'Notes', level: 3 })).toBeTruthy();
  expect(screen.getByText('The first paragraph is the content.')).toBeTruthy();
  expect(screen.queryByText('tags: [design]')).toBeNull();
});

it('keeps a leading heading when it differs from the document title', () => {
  const note = { ...block, title: 'Release notes', content: '# October changes\n\nDetails follow.' };
  vi.mocked(useDocumentContent).mockReturnValue({ block: note, loading: false, error: '', retry: vi.fn() });
  render(<CanvasSearchPreview hit={{ ...hit, title: note.title }} request={vi.fn()} evidenceEnabled/>);
  expect(screen.getByRole('heading', { name: 'October changes', level: 1 })).toBeTruthy();
});

it('shows non-Markdown source as text without interpreting markup', () => {
  const source = { ...block, kind: 'slides' as const, title: 'Slides', content: '<script>alert("source")</script>' };
  vi.mocked(useDocumentContent).mockReturnValue({ block: source, loading: false, error: '', retry: vi.fn() });
  render(<CanvasSearchPreview hit={{ ...hit, kind: 'slides', title: source.title }} request={vi.fn()} evidenceEnabled={false}/>);
  expect(screen.getByText(source.content).tagName).toBe('PRE');
  expect(screen.queryByText('source')).toBeNull();
});

it('shows a title match without source context and opens the item on its canvas', () => {
  const withoutEvidence = { ...hit, matchIn: 'title' as const, evidence: undefined };
  const request = vi.fn();
  render(<CanvasSearchPreview hit={withoutEvidence} request={request} evidenceEnabled={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('Title match')).toBeTruthy();
  expect(screen.queryByText('Source context')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show on canvas' }));
  expect(request).toHaveBeenCalledWith(withoutEvidence, 'reveal');
});

it('labels approximate evidence separately from an exact passage', () => {
  const approximate = { ...hit, evidence: { ...hit.evidence, passageKind: 'approximation' as const } };
  render(<CanvasSearchPreview hit={approximate} request={vi.fn()} evidenceEnabled/>);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('Approximate context')).toBeTruthy();
});

it('shows loading and lets the user retry a failed preview', () => {
  vi.mocked(useDocumentContent).mockReturnValue({ block: undefined, loading: true, error: '', retry: vi.fn() });
  const { rerender } = render(<CanvasSearchPreview hit={hit} request={vi.fn()} evidenceEnabled/>);
  expect(screen.getByRole('status').textContent).toContain('Loading document preview');
  const retry = vi.fn();
  vi.mocked(useDocumentContent).mockReturnValue({ block: undefined, loading: false, error: 'Network error', retry });
  rerender(<CanvasSearchPreview hit={hit} request={vi.fn()} evidenceEnabled/>);
  expect(screen.getByRole('alert').textContent).toContain('Could not load document');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
});
