// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SearchHit } from '../shared/types';
import { CanvasSearch } from './CanvasSearch';

const hits: SearchHit[] = [
  { canvasId: 'project', canvasName: 'Project', blockId: 'one', title: 'One', excerpt: 'Search item one.', tags: ['first'], group: 'custom:g', kind: 'markdown', matchIn: 'title' },
  { canvasId: 'project', canvasName: 'Project', blockId: 'two', title: 'Two', excerpt: 'Search item two.', tags: ['second'], kind: 'slides', matchIn: 'body' },
  { canvasId: 'research', canvasName: 'Research', blockId: 'three', title: 'Three', excerpt: 'Search item three.', tags: ['first'], kind: 'mdx', matchIn: 'title' },
];
type Props = ComponentProps<typeof CanvasSearch>;
function props(overrides: Partial<Props> = {}): Props {
  return { query: 'item', hits, loading: false, currentCanvasId: 'project', onQuery: vi.fn(), onClose: vi.fn(), onReveal: vi.fn(), onEdit: vi.fn(), ...overrides };
}
function input() { return screen.getByRole('textbox', { name: 'Search every Markdown file' }); }
function results() { return within(screen.getByRole('listbox', { name: 'Search results' })).queryAllByRole('option'); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('starts keyboard navigation with a local result after the active canvas changes', () => {
  const callbacks = props();
  const view = render(<CanvasSearch {...callbacks}/>);
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(screen.getByText('2 of 3')).toBeTruthy();
  view.rerender(<CanvasSearch {...callbacks} currentCanvasId="research"/>);
  expect(screen.getByText('1 of 3')).toBeTruthy();
  expect(results()[0].getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(callbacks.onReveal).toHaveBeenCalledWith(hits[2]);
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
});

it('discards a pending foreign action when a new query is loading', () => {
  const callbacks = props();
  const view = render(<CanvasSearch {...callbacks}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Show Three on canvas' }));
  expect(screen.getByRole('dialog', { name: 'Switch canvas' })).toBeTruthy();
  view.rerender(<CanvasSearch {...callbacks} query="different" loading hits={[]}/>);
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  expect(callbacks.onReveal).not.toHaveBeenCalled();
});

it('connects the focused input to the active result announced by its listbox', () => {
  render(<CanvasSearch {...props()}/>);
  const listbox = screen.getByRole('listbox', { name: 'Search results' });
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute('aria-controls')).toBe(listbox.id);
  expect(input().getAttribute('aria-activedescendant')).toBe(results()[0].id);
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(input().getAttribute('aria-activedescendant')).toBe(results()[1].id);
});

it('filters distinct canvases independently when their display names are identical', () => {
  const sameNames = hits.map(hit => ({ ...hit, canvasName: 'Shared notes' }));
  render(<CanvasSearch {...props({ hits: sameNames })}/>);
  fireEvent.change(screen.getByLabelText('Filter by canvas'), { target: { value: 'research' } });
  expect(results()).toHaveLength(1);
  expect(results()[0].textContent).toContain('Three');
});

it('lets the canvas confirmation own focus and Escape, then restores the triggering control', () => {
  const callbacks = props();
  render(<CanvasSearch {...callbacks}/>);
  const trigger = screen.getByRole('button', { name: 'Show Three on canvas' });
  trigger.focus();
  fireEvent.click(trigger);
  const confirm = screen.getByRole('dialog', { name: 'Switch canvas' });
  const cancel = within(confirm).getByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(callbacks.onClose).not.toHaveBeenCalled();
});

it('forwards typing, clear, close, and Escape while leaving unrelated keys alone', () => {
  const callbacks = props();
  const view = render(<CanvasSearch {...callbacks}/>);
  fireEvent.change(input(), { target: { value: 'new query' } });
  expect(callbacks.onQuery).toHaveBeenCalledWith('new query');
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(callbacks.onQuery).toHaveBeenLastCalledWith('');
  fireEvent.keyDown(input(), { key: 'a' });
  expect(callbacks.onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(input(), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
  expect(callbacks.onClose).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter by canvas' }), { key: 'Escape' });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(callbacks.onClose).toHaveBeenCalledTimes(4);
  view.rerender(<CanvasSearch {...callbacks} query=""/>);
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  expect(screen.getByText('Search titles and content across your workspaces.')).toBeTruthy();
  expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  expect(screen.queryByText('1 of 3')).toBeNull();
  expect(results()[0].querySelector('mark')).toBeNull();
});

it('wraps next and previous controls and edits the local selected result', () => {
  const callbacks = props();
  render(<CanvasSearch {...callbacks}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Previous search result' }));
  expect(screen.getByText('3 of 3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next search result' }));
  expect(screen.getByText('1 of 3')).toBeTruthy();
  fireEvent.keyDown(input(), { key: 'ArrowUp' });
  expect(screen.getByText('3 of 3')).toBeTruthy();
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit One' }));
  expect(callbacks.onEdit).toHaveBeenCalledWith(hits[0]);
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show One on canvas' }));
  expect(callbacks.onReveal).toHaveBeenCalledWith(hits[0]);
});

it('distinguishes empty, whitespace, loading, failed, and related-document searches', () => {
  const callbacks = props({ hits: [] });
  const view = render(<CanvasSearch {...callbacks}/>);
  expect(screen.getByText('No matching documents.')).toBeTruthy();
  expect(screen.getByText('0 of 0')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next search result' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(input(), { key: 'Enter' });
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(callbacks.onReveal).not.toHaveBeenCalled();
  view.rerender(<CanvasSearch {...callbacks} query="   " loading error="ignored"/>);
  expect(screen.getByText('Search titles and content across your workspaces.')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(<CanvasSearch {...callbacks} loading error="disconnected"/>);
  expect(screen.getByRole('status').textContent).toContain('Results are loading');
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  fireEvent.keyDown(input(), { key: 'Enter' });
  view.rerender(<CanvasSearch {...callbacks} error="disconnected"/>);
  expect(screen.getByRole('alert').textContent).toContain('disconnected');
  fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  view.rerender(<CanvasSearch {...callbacks}/>);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('0 of 0')).toBeTruthy();
  view.rerender(<CanvasSearch {...callbacks} hits={hits}/>);
  expect(screen.getByText('1 of 3')).toBeTruthy();
  expect(results()).toHaveLength(3);
  expect(callbacks.onReveal).not.toHaveBeenCalled();
});

it('combines all metadata filters and resets selection when each filter changes', () => {
  render(<CanvasSearch {...props()}/>);
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  fireEvent.change(screen.getByLabelText('Filter by group'), { target: { value: 'custom:g' } });
  expect(screen.getByText('1 of 1')).toBeTruthy();
  expect(results()[0].textContent).toContain('One');
  fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'second' } });
  expect(screen.getByText('No matching documents for these filters.')).toBeTruthy();
  expect(results()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Filter by group'), { target: { value: 'all' } });
  expect(results()[0].textContent).toContain('Two');
  fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'mdx' } });
  expect(results()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'all' } });
  expect(results()[0].textContent).toContain('Three');
  fireEvent.change(screen.getByLabelText('Filter by canvas'), { target: { value: 'project' } });
  expect(results()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Filter by canvas'), { target: { value: 'all' } });
  fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'all' } });
  expect(results()).toHaveLength(3);
});

it('renders legacy missing metadata safely and excludes missing tags from tag filters', () => {
  const legacy = { ...hits[0], canvasName: '', tags: undefined, kind: '' } as unknown as SearchHit;
  render(<CanvasSearch {...props({ hits: [legacy, hits[1]] })}/>);
  expect(results()[0].textContent).toContain('in project › G · markdown');
  fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'second' } });
  expect(results()).toHaveLength(1);
  expect(results()[0].textContent).toContain('Two');
});

it('labels fuzzy, term, phrase, exact, and ordinary matches', () => {
  const kinds = ['fuzzy_title', 'terms', 'phrase', 'exact'] as const;
  const matched = kinds.map((kind, index) => ({ ...hits[0], blockId: `match-${index}`, title: `Match ${index}`, retrieval: { kind, matchedTerms: ['item'] } }));
  render(<CanvasSearch {...props({ hits: [...matched, hits[1]] })}/>);
  for (const label of ['Similar title', 'Related terms', 'Phrase match', 'Title match', 'Body match']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
});

it('confirms foreign edits without invoking another action and cancels foreign reveals', () => {
  const callbacks = props();
  render(<CanvasSearch {...callbacks}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Three' }));
  expect(callbacks.onEdit).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch canvas' })).getByRole('button', { name: 'Switch canvas' }));
  expect(callbacks.onEdit).toHaveBeenCalledWith(hits[2]);
  expect(callbacks.onReveal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show Three on canvas' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch canvas' })).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  expect(callbacks.onReveal).not.toHaveBeenCalled();
});

it('keeps background input actions inactive while the canvas confirmation owns the keyboard', () => {
  const callbacks = props();
  render(<CanvasSearch {...callbacks}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Three' }));
  fireEvent.keyDown(input(), { key: 'Enter' });
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(callbacks.onReveal).not.toHaveBeenCalled();
  const confirm = screen.getByRole('dialog', { name: 'Switch canvas' });
  const cancel = within(confirm).getByRole('button', { name: 'Cancel' });
  const switchCanvas = within(confirm).getByRole('button', { name: 'Switch canvas' });
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(switchCanvas);
  fireEvent.keyDown(switchCanvas, { key: 'Tab' });
  expect(document.activeElement).toBe(cancel);
  expect(input().closest('[inert]')).not.toBeNull();
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(callbacks.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  expect(input().closest('[inert]')).toBeNull();
});

it('gives dashed canvas and document identities distinct active-result IDs', () => {
  const colliding = [
    { ...hits[0], canvasId: 'a-b', blockId: 'c' },
    { ...hits[1], canvasId: 'a', blockId: 'b-c' },
  ];
  render(<CanvasSearch {...props({ hits: colliding, currentCanvasId: 'a-b' })}/>);
  expect(results()[0].id).not.toBe(results()[1].id);
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(document.getElementById(input().getAttribute('aria-activedescendant')!)).toBe(results()[1]);
});

it('returns focus to search when a pending result disappears with its trigger', () => {
  const callbacks = props();
  const view = render(<CanvasSearch {...callbacks}/>);
  const trigger = screen.getByRole('button', { name: 'Edit Three' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  view.rerender(<CanvasSearch {...callbacks} hits={[]} loading/>);
  expect(screen.queryByRole('dialog', { name: 'Switch canvas' })).toBeNull();
  expect(document.activeElement).toBe(input());
  expect(callbacks.onEdit).not.toHaveBeenCalled();
});
