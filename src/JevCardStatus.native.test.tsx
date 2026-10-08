// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JevCardStatus } from './JevCardStatus';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { sourceSnapshot } from '../server/jev/stamps';
import type { CanvasBlock } from '../shared/types';

afterEach(async () => { cleanup(); await closeWorkspaceFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function organize(fixture: Awaited<ReturnType<typeof workspaceFixture>>, block: CanvasBlock, id: string) {
  const saved = await fixture.store.jevExecutor.execute({ kind: 'document', canvasId: fixture.canvas.id, blockId: block.id, patch: { headline: `Organized ${id}` } },
    [sourceSnapshot(fixture.workspace.id, fixture.canvas.id, block)], id, 'Jev', true,
    prepared => writeFile(path.join(fixture.root, `${id}.json`), JSON.stringify(prepared)));
  expect(saved.after).toMatchObject({ kind: 'document', blockId: block.id });
  return fixture.store.getCanvasBlock(fixture.canvas.id, block.id);
}

it('keeps initial native Jev provenance quiet and briefly signals only a subsequent applied mutation', async () => {
  const fixture = await workspaceFixture(); const initial = fixture.canvas.blocks[0];
  const organized = await organize(fixture, initial, 'first-native-mutation');
  const view = render(<JevCardStatus block={organized} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  expect(screen.getByLabelText('Organized by Reflex').textContent).toBe('Reflex did it'); expect(screen.queryByRole('status')).toBeNull();
  const manuallyEdited = await fixture.store.updateBlock(fixture.canvas.id, organized.id, { title: 'Manually titled source' });
  view.rerender(<JevCardStatus block={manuallyEdited} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />); expect(screen.queryByRole('status')).toBeNull();
  const next = await organize(fixture, manuallyEdited, 'second-native-mutation');
  vi.useFakeTimers(); view.rerender(<JevCardStatus block={next} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  expect(screen.getByRole('status').textContent).toBe('Updated by Reflex');
  view.rerender(<JevCardStatus block={{ ...next, x: next.x + 50 }} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); expect(screen.queryByRole('status')).toBeNull(); expect(screen.getByLabelText('Organized by Reflex')).toBeTruthy();
});

it('signals a first applied mutation on an already mounted card, cancels replaced timers and stays quiet when provenance is cleared', async () => {
  const fixture = await workspaceFixture(); const initial = fixture.canvas.blocks[0];
  const view = render(<JevCardStatus block={initial} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  expect(view.container.innerHTML).toBe('');
  const first = await organize(fixture, initial, 'fresh-native-mutation'); const second = await organize(fixture, first, 'newer-native-mutation');
  vi.useFakeTimers(); view.rerender(<JevCardStatus block={first} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  view.rerender(<JevCardStatus block={second} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(800); }); expect(screen.getByRole('status')).toBeTruthy();
  view.rerender(<JevCardStatus block={{ ...second, jevMutationId: undefined }} onOpenRelated={() => { throw new Error('No duplicate should be clickable'); }} />); expect(screen.queryByRole('status')).toBeNull(); expect(view.container.innerHTML).toBe('');
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
});

it('renders supplied checked duplicate references on both cards and opens the exact related source without bubbling', async () => {
  const fixture = await workspaceFixture(); const [left, right] = fixture.canvas.blocks;
  const open: string[] = []; const parent = vi.fn();
  const view = render(<div onClick={parent}><JevCardStatus block={{ ...left, jevDuplicates: [{ findingId: 'checked-finding', blockId: right.id, title: right.title }] }} onOpenRelated={id => open.push(id)} />
    <JevCardStatus block={{ ...right, jevDuplicates: [{ findingId: 'checked-finding', blockId: left.id, title: left.title }] }} onOpenRelated={id => open.push(id)} /></div>);
  fireEvent.click(screen.getByRole('button', { name: `Possible duplicate: ${right.title}` })); fireEvent.click(screen.getByRole('button', { name: `Possible duplicate: ${left.title}` }));
  expect(open).toEqual([right.id, left.id]); expect(parent).not.toHaveBeenCalled(); expect(screen.queryByLabelText('Organized by Reflex')).toBeNull();
  view.rerender(<JevCardStatus block={{ ...left, jevDuplicates: [] }} onOpenRelated={id => open.push(id)} />); expect(screen.queryByRole('button')).toBeNull();
});
