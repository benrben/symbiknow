// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { BrowseGroups } from './BrowseGroups';

function documentBlock(id: string, title: string, group?: string): CanvasBlock {
  return { id, title, group, file: id + '.md', kind: 'markdown', content: '# ' + title, x: 100, y: 200, width: 320, height: 240, links: [] };
}
function canvas(blocks: CanvasBlock[]): CanvasDocument {
  return { id: 'library', workspaceId: 'team', name: 'Saved library', blocks };
}
function Owner({ initial }: { initial: CanvasDocument | null }) {
  const [current, setCurrent] = useState(initial);
  const [open, setOpen] = useState(true);
  const [opened, setOpened] = useState('');
  const [closed, setClosed] = useState(0);
  const [keys, setKeys] = useState<string[]>([]);
  return <div onKeyDown={event => { setKeys(values => [...values, event.key]); }}>
    <button onClick={() => { setOpen(true); }}>Reopen library</button>
    <button onClick={() => { setCurrent(canvas([documentBlock('only', 'Only document')])); }}>Load one document</button>
    <button onClick={() => { setCurrent(canvas([])); }}>Load empty canvas</button>
    <output aria-label="Opened document">{opened}</output>
    <output aria-label="Close count">{closed}</output>
    <output aria-label="Owner keys">{JSON.stringify(keys)}</output>
    {open && <BrowseGroups canvas={current} onOpenBlock={setOpened}
      onClose={() => { setClosed(value => value + 1); setOpen(false); }} />}
  </div>;
}

afterEach(cleanup);

describe('BrowseGroups through a supported public React owner', () => {
  it('renders null, empty and singular saved-canvas defaults', () => {
    render(<Owner initial={null} />);
    let library = screen.getByRole('complementary', { name: 'Browse groups' });
    expect(library.textContent).toContain('No canvas selected · 0 documents');
    expect(within(library).getByText('No documents in this canvas yet.')).toBeTruthy();
    expect(within(library).queryAllByRole('region')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Load one document' }));
    library = screen.getByRole('complementary', { name: 'Browse groups' });
    expect(library.textContent).toContain('Saved library · 1 document');
    expect(within(library).getByRole('region', { name: 'Ungrouped' }).textContent).toContain('Only document');
    fireEvent.click(screen.getByRole('button', { name: 'Load empty canvas' }));
    expect(library.textContent).toContain('Saved library · 0 documents');
    expect(within(library).getByText('No documents in this canvas yet.')).toBeTruthy();
  });

  it('sorts normalized saved groups and equal-title IDs, preserves long Unicode names and routes the actual chosen ID without mutating input order', async () => {
    const title = 'Evidence 🚀 ' + 'אבג漢字'.repeat(35);
    const source = canvas([
      documentBlock('loose', 'Loose note'), documentBlock('zebra', 'Zebra note', 'custom:zebra'),
      documentBlock('b', 'Duplicate title', 'custom:alpha'), documentBlock('a', 'Duplicate title', 'custom:alpha'),
      documentBlock('unicode', title, 'custom:alpha/notes'), documentBlock('work', 'Lane note', 'work'),
      documentBlock('earlier', 'Alpha title', 'custom:alpha'),
    ]);
    const originalOrder = source.blocks.map(value => value.id);
    render(<Owner initial={source} />);
    const library = screen.getByRole('complementary', { name: 'Browse groups' });
    expect(library.textContent).toContain('Saved library · 7 documents');
    expect(within(library).getAllByRole('region').map(value => value.getAttribute('aria-label'))).toEqual([
      'Active work', 'Alpha', 'Alpha / Notes', 'Zebra', 'Ungrouped',
    ]);
    const alpha = within(library).getByRole('region', { name: 'Alpha' });
    const buttons = within(alpha).getAllByRole('button');
    expect(buttons.map(value => value.textContent)).toEqual(['Alpha titlemarkdown', 'Duplicate titlemarkdown', 'Duplicate titlemarkdown']);
    await userEvent.click(buttons[1]);
    expect(screen.getByLabelText('Opened document').textContent).toBe('a');
    await userEvent.click(buttons[2]);
    expect(screen.getByLabelText('Opened document').textContent).toBe('b');
    const unicode = within(library).getByRole('button', { name: 'Open ' + title });
    expect(unicode.querySelector('span')?.textContent).toBe(title);
    expect(unicode.querySelector('small')?.getAttribute('aria-hidden')).toBe('true');
    unicode.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Opened document').textContent).toBe('unicode');
    expect(source.blocks.map(value => value.id)).toEqual(originalOrder);
  });

  it('lets normal native keys reach its owner but closes once on Escape without propagating it, then supports its Close button', async () => {
    render(<Owner initial={canvas([documentBlock('one', 'One document')])} />);
    const chosen = screen.getByRole('button', { name: 'Open One document' });
    chosen.focus();
    await userEvent.keyboard('x');
    expect(screen.getByLabelText('Owner keys').textContent).toBe('["x"]');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    expect(screen.getByLabelText('Owner keys').textContent).toBe('["x"]');
    expect(screen.getByLabelText('Close count').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Reopen library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close browse groups' }));
    expect(screen.queryByRole('complementary', { name: 'Browse groups' })).toBeNull();
    expect(screen.getByLabelText('Close count').textContent).toBe('2');
  });
});
