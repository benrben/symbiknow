// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types';
import { CanvasDrillBoard, CanvasOverview, type OverviewGroup } from './CanvasOverview';
function document(id: string, extra: Partial<CanvasBlock> = {}): CanvasBlock {
  return { id, title: 'Document ' + id, kind: 'markdown', file: id + '.md', content: '# Evidence', links: [], x: 0, y: 0, width: 320, height: 240, ...extra };
}
function group(key: string, extra: Partial<OverviewGroup> = {}): OverviewGroup {
  return { id: key, group: key, title: key, count: 1, tone: 0, depth: 0, topTitles: [], ...extra };
}
afterEach(cleanup);
describe('CanvasOverview normal group navigation', () => {
  it('keeps root navigation and search counts while removing the separate group-list page', () => {
    const focus = vi.fn();
    render(<CanvasOverview groups={[group('custom:a', { title: 'Alpha' }), group('custom:a/child', { depth: 1 }), group('custom:b', { title: 'Beta' })]} blocks={[document('a', { group: 'custom:a/child' })]} searchIds={new Set(['a'])} matchCount={1} overview drill={false} onFocus={focus}/>);
    expect(screen.queryByRole('button', { name: 'Show group list' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Group overview' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Mini-map groups' });
    fireEvent.click(within(nav).getByText('Map · 1 match'));
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['Alpha1●', 'Beta1']);
    fireEvent.click(within(nav).getByRole('button', { name: /^Alpha1/ }));
    expect(focus).toHaveBeenCalledWith('custom:a');
    expect(within(nav).getAllByLabelText('Search matches in group')).toHaveLength(1);
  });
  it('resets map disclosure for overview changes and retains drill navigation', () => {
    const options = { groups: [group('custom:a'), group('custom:b')], blocks: [], searchIds: new Set<string>(), matchCount: 0, overview: true, drill: false, onFocus: vi.fn() };
    const view = render(<CanvasOverview {...options}/>);
    expect(screen.queryByText(/matches/)).toBeNull();
    fireEvent.click(screen.getByText('Map · 2 groups'));
    expect(screen.getByText('Map · 2 groups').parentElement?.hasAttribute('open')).toBe(true);
    view.rerender(<CanvasOverview {...options} overview={false} drill/>);
    expect(screen.getByText('Map · 2 groups').parentElement?.hasAttribute('open')).toBe(false);
    expect(screen.getByRole('navigation', { name: 'Mini-map groups' }).className).toContain('is-drill');
  });
});

describe('CanvasDrillBoard public subgroup and document boundaries', () => {
  it('keeps immediate child order, descendant membership, labels and excerpt normalization', () => {
    const groups = [group('custom:launch', { title: 'Launch', tone: 4 }), group('custom:launch/notes', { title: 'Notes', depth: 1 }), group('custom:launch/notes/deep', { title: 'Deep', depth: 2 }), group('custom:launch/reference', { title: 'Reference', depth: 1 }), group('custom:other/notes', { title: 'Other notes', depth: 1 })];
    const blocks = [document('root', { group: 'custom:launch', content: '---\r\ntitle: Hidden\r\n---\r\n# Hello <b>world</b>\n **[evidence]**' }), document('child', { group: 'custom:launch/notes/deep', content: ' # * ` > [ ] <i></i>  ' }), document('other', { group: 'custom:other' })];
    const focus = vi.fn();
    const select = vi.fn();
    render(<CanvasDrillBoard group="custom:launch" groups={groups} blocks={blocks} onFocus={focus} onSelect={select} />);
    const board = screen.getByRole('region', { name: 'Launch group documents' });
    expect(board.className).toContain('canvas-group--tone-4');
    expect(within(board).getByText('2 documents · 2 subgroups')).toBeTruthy();
    expect([...board.querySelectorAll('.canvas-drill-board__children strong')].map(item => item.textContent)).toEqual(['Notes', 'Reference']);
    fireEvent.click(within(board).getByRole('button', { name: 'Notes1 docs' }));
    expect(focus).toHaveBeenLastCalledWith('custom:launch/notes');
    const root = within(board).getByRole('button', { name: /Document root/ });
    expect(root.querySelector('small')?.textContent).toBe('markdown');
    expect(within(root).getByText('Hello world evidence')).toBeTruthy();
    const child = within(board).getByRole('button', { name: /Document child/ });
    expect(child.querySelector('small')?.textContent).toBe('markdown · deep');
    expect(within(child).getByText('Open this document to read more.')).toBeTruthy();
    fireEvent.click(child);
    expect(select).toHaveBeenLastCalledWith('child');
    expect(within(board).queryByText('Document other')).toBeNull();
  });
  it('renders singular counts and limits content using the original UTF-16 slice order', () => {
    const content = '🚀'.repeat(150) + ' visible ' + 'z'.repeat(2400);
    render(<CanvasDrillBoard group="custom:launch" groups={[group('custom:launch'), group('custom:launch/notes', { depth: 1 })]} blocks={[document('long', { group: 'custom:launch/notes', content })]} onFocus={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByText('1 document · 1 subgroup')).toBeTruthy();
    const button = screen.getByRole('button', { name: /Document long/ });
    expect(button.querySelector(':scope > span')?.textContent).toBe(content.slice(0, 220));
  });
  it('uses the fallback frame title, tone and empty board counts', () => {
    render(<CanvasDrillBoard group="custom:absent" groups={[]} blocks={[document('outside')]} onFocus={vi.fn()} onSelect={vi.fn()} />);
    const board = screen.getByRole('region', { name: 'custom:absent group documents' });
    expect(board.className).toContain('canvas-group--tone-0');
    expect(within(board).getByRole('heading', { name: 'custom:absent' })).toBeTruthy();
    expect(within(board).getByText('0 documents')).toBeTruthy();
    expect(board.querySelector('.canvas-drill-board__children')).toBeNull();
    expect(within(board).queryByRole('button')).toBeNull();
  });
});
