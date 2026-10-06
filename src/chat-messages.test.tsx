// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer, TurnMessage } from './chat-messages';
import type { DisplayTurn } from './chat-types';
import type { CanvasBlock } from '../shared/types';

const block: CanvasBlock = { id: 'qa', title: 'QA report', content: 'Original QA', file: 'qa.md', kind: 'markdown', x: 0, y: 0, width: 300, height: 200, links: [] };
const after = { ...block, content: 'Revised QA' };
const base: DisplayTurn = { id: 2, role: 'assistant', content: 'Finished answer', activities: [] };
function props(turn: Partial<DisplayTurn> = {}, overrides: Partial<ComponentProps<typeof TurnMessage>> = {}): ComponentProps<typeof TurnMessage> {
  return { turn: { ...base, ...turn }, status: 'ready', latestId: 2, avatarState: 'idle', undoingBlockId: null, onShowBlock: vi.fn(), onOpenAnswerCanvas: vi.fn(), onChooseSurface: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreated: vi.fn(), onUndoEdited: vi.fn(), onSelectProposal: vi.fn(), onApplyProposal: vi.fn(), onUndoProposal: vi.fn(), ...overrides };
}
const staged = { id: 'review', status: 'pending' as const, canvasId: 'planning', expiresAt: '2026-10-01T13:00:00Z', changes: [{ id: 'edit', type: 'edit' as const, blockId: block.id, title: block.title, before: block, after, expectedContentHash: null }] };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('public proposal and research controls', () => {
  it('shows full before/after metadata, handles selections, blocks inapplicable changes and preserves Apply/Undo callbacks', () => {
    const blocked = { ...staged.changes[0], id: 'blocked', type: 'create' as const, title: 'Locked note', before: null, after: null, canApply: false };
    const current = props({ proposal: { ...staged, changes: [staged.changes[0], blocked] }, proposalState: 'pending' }); const view = render(<TurnMessage {...current}/>); const region = screen.getByRole('region', { name: 'Review proposed document changes' });
    expect(within(region).getByText(/Available until/)).toBeTruthy(); expect(within(region).getByText('(new document)')).toBeTruthy(); expect(within(region).getByText('(removed document)')).toBeTruthy();
    expect((within(region).getByRole('checkbox', { name: /Locked note/ }) as HTMLInputElement).disabled).toBe(true); fireEvent.click(within(region).getByRole('checkbox', { name: /QA report/ })); expect(current.onSelectProposal).toHaveBeenCalledWith(2, 'edit', true);
    expect((within(region).getByRole('button', { name: 'Apply selected (0)' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<TurnMessage {...current} turn={{ ...current.turn, selectedProposalIds: ['edit'] }}/>); fireEvent.click(screen.getByRole('button', { name: 'Apply selected (1)' })); expect(current.onApplyProposal).toHaveBeenCalledWith(2);
    view.rerender(<TurnMessage {...current} turn={{ ...current.turn, proposalState: 'applied', proposalReceipt: { id: 'review', status: 'applied', applied: ['edit'], skipped: [], createdBlockIds: {} } }}/>); fireEvent.click(screen.getByRole('button', { name: 'Undo applied changes' })); expect(current.onUndoProposal).toHaveBeenCalledWith(2);
  });

  it('shows receipts with plural counts, skipped changes, legacy Undo receipts and lifecycle notices', () => {
    const current = props({ proposal: staged, proposalState: 'applied', proposalReceipt: { id: 'review', status: 'partial', applied: ['one', 'two'], skipped: [{ id: 'skip', reason: 'Newer edit' }], createdBlockIds: {} }, proposalUndoReceipt: { id: 'review', status: 'partial', reverted: ['one', 'two'], skipped: [{ id: 'skip', reason: 'Still changed' }] } }); const view = render(<TurnMessage {...current}/>);
    expect(screen.getByText(/2 changes saved; 1 skipped/)).toBeTruthy(); expect(screen.getByText(/2 changes reverted; 1 still applied/)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Retry Undo for remaining changes' })); expect(current.onUndoProposal).toHaveBeenCalledWith(2);
    const legacy = { id: 'review', status: 'reverted' as const, reverted: ['one'] }; view.rerender(<TurnMessage {...current} turn={{ ...current.turn, proposalState: 'reverted', proposalUndoReceipt: legacy as DisplayTurn['proposalUndoReceipt'] }}/>); expect(screen.getByText(/1 change reverted/)).toBeTruthy(); expect(screen.getByText(/The applied changes were reverted/)).toBeTruthy();
    view.rerender(<TurnMessage {...current} turn={{ ...current.turn, proposalState: 'expired', proposalError: 'Unavailable' }}/>); expect(screen.getByRole('alert').textContent).toBe('Unavailable'); expect(screen.getByText(/Ask Chat to prepare a fresh proposal/)).toBeTruthy();
    view.rerender(<TurnMessage {...current} turn={{ ...current.turn, proposalState: 'applying' }}/>); expect(screen.getByText('Applying selected changes…')).toBeTruthy();
  });

  it('opens research with a single block', () => {
    const current = props({ researchPatch: { query: 'QA', blocks: [{ id: 'research', title: 'Finding', content: 'Result', type: 'text', sourceIds: [] }], edges: [] } }, { question: 'What changed?' }); render(<TurnMessage {...current}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas · 1 new block ↗' })); expect(current.onOpenAnswerCanvas).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Answer briefly in chat' })); expect(current.onChooseSurface).toHaveBeenCalledWith('Answer briefly in chat with no canvas for: What changed?');
  });
});

it.each(['denied', 'unavailable'])('reports a %s Copy answer action and lets the user retry it', async failure => {
  if (failure === 'denied') vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Permission denied'));
  else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); render(<TurnMessage {...props()}/>); fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not copy answer. Select the answer text and copy it.'); expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  if (failure === 'unavailable') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy answer' })); await screen.findByRole('button', { name: 'Copied' }); expect(screen.queryByRole('alert')).toBeNull(); expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Finished answer');
});

it('keeps the composer controlled and routes trimmed Enter submission and Stop separately', async () => {
  const onInput = vi.fn(); const onSubmit = vi.fn(); const onStop = vi.fn(); const current = { canvasId: 'planning', model: 'fixture', hasApiKey: true, input: ' Question ', status: 'ready' as const, onInput, onSubmit, onStop }; const view = render(<ChatComposer {...current}/>);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Draft' } }); expect(onInput).toHaveBeenCalledWith('Draft'); fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Symbi' }), { key: 'Enter' }); await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Question'));
  view.rerender(<ChatComposer {...current} status="streaming" input=""/>); fireEvent.click(screen.getByRole('button', { name: 'Stop' })); expect(onStop).toHaveBeenCalledOnce(); expect(onSubmit).toHaveBeenCalledOnce();
});


it('clears the transient Copy receipt so the next copy can show its own success', async () => {
  render(<TurnMessage {...props()}/>); vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))); expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(1400)); expect(screen.getByRole('button', { name: 'Copy answer' })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))); expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy(); expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
});
