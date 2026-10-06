// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LockBadge } from './CanvasNodes';
import { block, installCanvasBrowser } from './canvas-model.test.helpers';
import { card, documentSeed, events, group, groupSeed, mountNodes, resizeHandle } from './CanvasNodes.test.helpers';

installCanvasBrowser();
describe('public document node contracts in the installed renderer', () => {
  it('keeps lock ownership, expiry and optional note visible without an own-actor editing badge', () => {
    const expiry = '2026-10-02T14:05:00Z';
    const value = block('a', { lock: { owner: 'Jev', expiresAt: expiry, note: 'Reviewing evidence' } });
    const ui = render(<LockBadge block={value}/>);
    const until = new Date(expiry).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(screen.getByTitle(`Jev is editing until ${until} — Reviewing evidence`).textContent).toBe('● Jev editing');
    ui.rerender(<LockBadge block={{ ...value, lock: { owner: 'Research agent', expiresAt: expiry } }}/>);
    expect(screen.getByTitle(`Research agent is editing until ${until}`).textContent).toBe('● Research agent editing');
    ui.rerender(<LockBadge block={{ ...value, lock: { owner: 'Browser', expiresAt: expiry } }}/>);
    expect(ui.container.textContent).toBe('');
    ui.rerender(<LockBadge block={block('a')}/>);
    expect(ui.container.textContent).toBe('');
  });
  it('renders manual metadata and ignores legacy quality scores', async () => {
    const base = block('a', { purpose: 'decision', workArea: 'custom/design_systems', reviewer: 'Ada 🚀',
      lock: { owner: 'Jev', expiresAt: '2026-10-02T14:05:00Z' }, quality: { score: .755, at: '2026-10-01' } });
    const ui = mountNodes([documentSeed({ block: base, highlighted: true, searchMatch: true, dimmed: true })]);
    const node = await card();
    expect(node.className).toContain('is-highlighted');
    expect(node.className).toContain('is-search-match');
    expect(node.className).toContain('is-dimmed');
    expect(node.className).toContain('is-locked');
    expect(within(node).getByTitle('Purpose: decision').textContent).toBe('decision');
    expect(within(node).getByTitle('Work area: design systems').textContent).toBe('design systems');
    expect(within(node).getByTitle('Reviewer: Ada 🚀').textContent).toBe('Review: Ada 🚀');
    expect(within(node).queryByRole('meter')).toBeNull();
    ui.change([documentSeed()]);
    await waitFor(() => expect(node.querySelector('.canvas-card__metadata')).toBeNull());
    ui.change([documentSeed({ block: block('a', { reviewer: 'Review pending' }) })]);
    await screen.findByTitle('Reviewer: Review pending');
    expect(within(node).queryByRole('meter')).toBeNull();
  });
  it('keeps portal order, count, labels and overflow, hides bodies and portals in title detail, and exposes one link singularly', async () => {
    const links = [{ canvasId: 'other', blockId: 'target' }, { canvasId: 'billing', blockId: 'invoice' }, { canvasId: 'research', blockId: 'evidence' }];
    const linked = block('a', { crossLinks: links });
    const ui = mountNodes([documentSeed({ block: linked, crossLinkLabels: { 'other:target': 'Other · Release evidence' } })]);
    const node = await card();
    expect(within(node).getByTitle('3 cross-canvas links').textContent).toBe('↗ 3');
    expect(within(node).getByText('+1 more')).toBeTruthy();
    expect(within(node).getByText('↗ Other canvas: Other · Release evidence')).toBeTruthy();
    expect(within(node).getByText('↗ Other canvas: billing')).toBeTruthy();
    expect(within(node).queryByRole('button', { name: 'Open related document evidence on canvas research' })).toBeNull();
    fireEvent.click(within(node).getByRole('button', { name: 'Open related document target on canvas other' }));
    expect(events()).toEqual(['portal:other:target']);
    ui.change([documentSeed({ block: linked, detail: 'titles' })]);
    await waitFor(() => expect(node.className).toContain('is-title-only'));
    expect(node.querySelector('.canvas-card__body')).toBeNull();
    expect(node.querySelector('.canvas-card__portals')).toBeNull();
    expect(node.querySelector('.canvas-card__portal-count')).toBeNull();
    ui.change([documentSeed({ block: block('a', { crossLinks: links.slice(0, 1) }) })]);
    await waitFor(() => expect(within(node).getByTitle('1 cross-canvas link')).toBeTruthy());
    expect(node.querySelector('.canvas-card__body')).toBeTruthy();
    expect(within(node).queryByText(/more/)).toBeNull();
    ui.change([documentSeed({ block: block('a', { crossLinks: [] }) })]);
    await waitFor(() => expect(node.querySelector('.canvas-card__portals')).toBeNull());
  });
  it('routes read/history/edit without bubbling the body double click', async () => {
    mountNodes([documentSeed()]);
    const node = await card(); const scoped = within(node);
    for (const name of ['Read Document a full page', 'History for Document a', 'Edit Document a']) fireEvent.click(scoped.getByRole('button', { name }));
    expect(events()).toEqual(['read:a', 'history:a', 'edit:a']);
    expect(scoped.queryByRole('menu')).toBeNull();
    fireEvent.doubleClick(scoped.getByRole('heading', { name: 'Evidence a' }));
    expect(events()).toHaveLength(3);
    fireEvent.doubleClick(node);
    expect(events().at(-1)).toBe('double:a');
  });
  it('resizes a selected document with the installed native handle and updates its controlled public dimensions', async () => {
    mountNodes([{ ...documentSeed(), selected: true }]);
    const node = await card();
    expect(node.className).toContain('is-selected');
    const handle = node.querySelector('.react-flow__resize-control.bottom.right.handle');
    if (!handle) throw new Error('Missing installed resize handle');
    resizeHandle(handle, 150, 80);
    await waitFor(() => expect(events()).toHaveLength(1));
    const patch = JSON.parse(events()[0].replace('update:a:', ''));
    expect(patch).toMatchObject({ width: 470, height: 320 });
    expect(node.closest('.react-flow__node')?.getAttribute('style')).toContain('width: 470px');
    expect(node.closest('.react-flow__node')?.getAttribute('style')).toContain('height: 320px');
  });
});

describe('public group node contracts in the installed renderer', () => {
  it.each([false, true])('drills and hovers only in overview while heading actions remain available (overview %s)', async overview => {
    mountNodes([groupSeed({ overview, count: 2 })]);
    const node = await group();
    const heading = node.querySelector<HTMLElement>('.canvas-group__heading');
    if (!heading) throw new Error('Missing group heading');
    expect(node.getAttribute('aria-label')).toBe('Alpha group, 2 documents');
    expect(within(node).getByText('2 docs')).toBeTruthy();
    expect(heading.title).toBe(overview ? 'Open Alpha' : 'Drag to move this group');
    fireEvent.click(node); fireEvent.mouseEnter(node); fireEvent.mouseLeave(node);
    fireEvent.mouseEnter(heading); fireEvent.mouseLeave(heading);
    expect(events()).toEqual(overview ? ['drill:custom:a', 'hover:custom:a', 'hover:null', 'hover:custom:a', 'hover:custom:a', 'hover:null', 'hover:null'] : []);
    fireEvent.click(within(node).getByRole('button', { name: 'Alpha' }));
    expect(events().at(-1)).toBe('drill:custom:a');
    if (overview) expect(within(node).queryByRole('button', { name: 'Collapse Alpha' })).toBeNull();
    else { fireEvent.click(within(node).getByRole('button', { name: 'Collapse Alpha' })); expect(events().at(-1)).toBe('collapse:custom:a'); }
  });
  it('keeps singular supergroups, file groups, summary order and memo updates', async () => {
    const seed = groupSeed({ kind: 'super', count: 1, overview: true, topTitles: ['Launch', 'Research'] });
    const ui = mountNodes([seed]); const node = await group();
    expect(node.getAttribute('aria-label')).toBe('Alpha supergroup, 1 group');
    expect(within(node).getByText('1 group')).toBeTruthy();
    expect([...node.querySelectorAll('.canvas-group__summary span')].map(item => item.textContent)).toEqual(['Launch', 'Research']);
    ui.change([{ ...seed }]);
    await waitFor(() => expect(node.getAttribute('aria-label')).toBe('Alpha supergroup, 1 group'));
    ui.change([groupSeed({ kind: 'super', count: 2, topTitles: ['Launch', 'Research'] })]);
    await waitFor(() => expect(node.getAttribute('aria-label')).toBe('Alpha supergroup, 2 groups'));
    ui.change([groupSeed({ kind: 'files', count: 1, collapsed: true, topTitles: ['Release 🚀'] })]);
    await waitFor(() => expect(node.getAttribute('aria-label')).toBe('Alpha group, 1 documents'));
    expect(within(node).getByText('1 doc')).toBeTruthy();
    expect(node.className).toContain('is-files'); expect(node.className).toContain('is-collapsed');
    expect(within(node).getByRole('button', { name: 'Expand Alpha' }).textContent).toBe('+');
    expect(within(node).getByText('Release 🚀')).toBeTruthy();
    ui.change([groupSeed({ topTitles: ['Changed 🚀'] })]);
    await waitFor(() => expect(node.querySelector('.canvas-group__summary')).toBeNull());
    expect(within(node).getByRole('button', { name: 'Collapse Alpha' }).textContent).toBe('−');
    fireEvent.click(node);
    ui.change([groupSeed({ collapsed: true, topTitles: ['Changed 🚀'] })]);
    await screen.findByText('Changed 🚀');
    ui.change([groupSeed({ collapsed: true, topTitles: ['Same length, new title'] })]);
    await screen.findByText('Same length, new title');
    ui.change([groupSeed({ collapsed: true, topTitles: [] })]);
    await waitFor(() => expect(node.querySelectorAll('.canvas-group__summary span')).toHaveLength(0));
  });
  it('shows links beyond an overview group when their target is outside the current zoom view', async () => {
    mountNodes([groupSeed({ overview: true, internalLinkCount: 1, externalLinkCount: 2 })]);
    const node = await group();
    expect(within(node).getByText('↗ 1 link inside')).toBeTruthy();
    expect(within(node).getByText('↗ 2 links beyond this group')).toBeTruthy();
  });
});
