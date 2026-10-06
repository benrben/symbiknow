// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answer, fixture, toolCalls } from '../server/chat-session.test.fixture';
import { CanvasStore } from '../server/storage';
import { AIElementsChat } from './AIElementsChat';
import { chatHistoryKey } from './chat-history';
import { isSavedTurn } from './chat-history-values';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';

const nativeFetch = globalThis.fetch;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear();
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

describe('native streamed conversation, tool activity and history recovery', () => {
  it('preserves an actual DeepAgents conversation after a damaged saved activity, with native source readback', async () => {
    const setup = await fixture();
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response); return; }
      toolCalls(response, [{ name: 'read_doc', args: { blockId: 'launch-checklist' } }], 'Checking the native checklist. ');
    };
    const base = await setup.app();
    const httpReads: Array<{ path: string; status: number }> = [];
    // Route relative browser requests to the actual server without altering any response or stream.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await nativeFetch(new URL(String(input), base), init);
      httpReads.push({ path: String(input), status: response.status });
      return response;
    });
    const props: AIElementsChatProps = {
      canvasId: setup.canvas.id, canvas: setup.canvas, viewContext: { selectedBlockIds: [] }, answerTurns: [],
      hasApiKey: true, model: setup.settings.model, onOpenSettings: vi.fn(),
      onCanvasChanged: async (id, before) => {
        const current = await nativeFetch(`${base}/api/canvases/${id}`).then(response => response.json());
        expect(current.blocks).toEqual(before);
        return { created: [], updated: [] };
      },
      onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(),
      onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(),
      onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn(),
    };
    const first = render(<AIElementsChat {...props} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Read the launch checklist and explain the release gate.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(first.container.querySelector('.ai-chat__answer')?.textContent).toBe('The release requires QA approval.'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    const activity = screen.getByRole('region', { name: 'Agent activity' });
    // Finish the stream-to-ready collapse effect before opening the completed history.
    await within(activity).findByText('Activity complete');
    await act(async () => { expect(within(activity).getByText('Activity complete')).toBeTruthy(); });
    const activityToggle = within(activity).getByRole('button');
    expect(activityToggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(activityToggle); });
    expect(activityToggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(activity).getByText('Checking the native checklist.')).toBeTruthy();
    expect(within(activity).getByText('Finished read_doc')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(setup.model.requests).toHaveLength(2);
    expect(setup.model.requests[1].body.messages.find(message => message.role === 'tool')?.content)
      .toContain('The release requires QA approval.');
    expect(httpReads).toContainEqual({ path: '/api/chat/stream', status: 200 });
    await act(async () => fireEvent(window, new Event('pagehide')));
    const saved = JSON.parse(localStorage.getItem(chatHistoryKey)!) as DisplayTurn[];
    expect(saved).toHaveLength(2);
    expect(saved.filter(isSavedTurn)).toEqual(saved);
    expect(saved[1].activities.every(value => value.status !== 'active')).toBe(true);
    first.unmount();
    localStorage.setItem(chatHistoryKey, JSON.stringify([...saved,
      { id: 500, role: 'assistant', content: 'Damaged turn', activities: [null] }]));
    const reopened = render(<AIElementsChat {...props} />);
    await waitFor(() => expect(reopened.container.querySelector('.ai-chat__answer')?.textContent).toBe('The release requires QA approval.'));
    expect(screen.getByText(saved[0].content)).toBeTruthy();
    expect(screen.queryByText('Damaged turn')).toBeNull();
    await act(async () => fireEvent(window, new Event('pagehide')));
    expect(JSON.parse(localStorage.getItem(chatHistoryKey)!)).toEqual(saved);
    const fresh = new CanvasStore(setup.root);
    expect(await fresh.getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    expect(setup.model.requests).toHaveLength(2);
    reopened.unmount();
  });
});
