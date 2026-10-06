// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerCanvasTurn, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { fixture, answer, toolCalls } from '../server/chat-session.test.fixture';
import { AIElementsChat } from './AIElementsChat';
import type { AIElementsChatProps } from './chat-types';
import { chatScopeOptions, currentViewLabel, requestContextForScope } from './chat-context';

const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [
  { id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: 'QA approval required', x: 0, y: 0, width: 300, height: 200, links: [] },
  { id: 'release', file: 'release.md', kind: 'markdown', title: 'Release plan', content: 'Release gate', x: 400, y: 0, width: 300, height: 200, links: [] },
  { id: 'blank', file: 'blank.md', kind: 'markdown', title: '', content: '', x: 800, y: 0, width: 300, height: 200, links: [] },
] };
const view: ChatViewContext = { selectedBlockIds: [] };
const draft = { title: '  Outline  ', content: 'Unsaved draft', kind: 'markdown' as const };
const focus = { level: 'big-picture' as const, visibleQuestions: ['Why?'], visibleSourceIds: ['qa'] };
function research(id: number, query = `Question ${id}`): AnswerCanvasTurn {
  return { id, query, answer: '', status: 'complete', sources: [{ canvasId: canvas.id, canvasName: canvas.name,
    blockId: `source-${id}`, title: `Source ${id}`, excerpt: 'Evidence', relevance: 1 }] };
}
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

describe('public assistant scope priority and request values', () => {
  const labels: Array<[Partial<ChatViewContext>, string]> = [
    [{ viewMode: 'answer', answerFocus: { ...focus, focusedBlockTitle: 'Risk map' }, selectedBlockIds: ['qa', 'release'] }, 'Research · Risk map'],
    [{ viewMode: 'answer', answerFocus: { ...focus, focusedBlockTitle: '' } }, 'Research canvas'],
    [{ viewMode: 'answer' }, 'Research canvas'],
    [{ selectedBlockIds: ['qa', 'release'], editorDraft: draft }, '2 selected documents'],
    [{ selectedBlockIds: ['qa'], readerBlockId: 'release', focusBlockId: 'release', editorDraft: draft }, 'QA report'],
    [{ readerBlockId: 'release', focusBlockId: 'qa' }, 'Release plan'],
    [{ focusBlockId: 'qa' }, 'QA report'],
    [{ selectedBlockIds: ['blank'], editorDraft: draft }, 'Draft · Outline'],
    [{ editorDraft: { ...draft, title: '   ' }, activeGroup: 'area:launch' }, 'Draft · Untitled'],
    [{ activeGroup: 'custom:release/qa', searchQuery: 'Other query' }, 'Qa group'],
    [{ searchQuery: '  launch QA  ', visibleGroups: ['custom:qa'] }, 'Search · launch QA'],
    [{ searchQuery: '   ', visibleGroups: ['custom:qa', 'custom:release'] }, '2 visible groups'],
    [{ visibleGroups: ['custom:qa'], viewMode: 'documents' }, 'Planning'],
    [{ visibleGroups: [] }, 'Planning'], [{}, 'Planning'],
  ];
  it.each(labels)('preserves label precedence for %j', (context, expected) => {
    const current = { ...view, ...context };
    expect(currentViewLabel(canvas, current)).toBe(expected);
    expect(chatScopeOptions(canvas, current, [])[0]).toEqual({ id: 'view', label: 'Current view', detail: expected, context: current });
  });
  it('preserves empty canvas titles and falls back only when the snapshot is absent', () => {
    expect(currentViewLabel(null, view)).toBe('Current canvas');
    expect(currentViewLabel({ ...canvas, name: '' }, view)).toBe('');
    expect(currentViewLabel(null, { ...view, focusBlockId: 'qa', searchQuery: ' release ' })).toBe('Search · release');
    expect(chatScopeOptions(null, view, [])[1]).toEqual({ id: 'canvas', label: 'Whole canvas', detail: 'All documents',
      context: { selectedBlockIds: [], viewMode: 'overview', answerSourceIds: [] } });
  });
  it('preserves scope order, selection identity and the original view object', () => {
    const selected = ['release', 'qa'];
    const current = { ...view, selectedBlockIds: selected };
    const options = chatScopeOptions(canvas, current, [research(1)]);
    expect(options.map(option => option.id)).toEqual(['view', 'canvas', 'selection', 'research']);
    expect(options[0].context).toBe(current);
    expect(options[2]).toEqual({ id: 'selection', label: 'Selected documents', detail: '2 selected',
      context: { selectedBlockIds: selected, viewMode: 'documents', visibleBlockIds: selected } });
    expect(options[2].context.selectedBlockIds).toBe(selected);
    expect(chatScopeOptions(canvas, view, []).map(option => option.id)).toEqual(['view', 'canvas']);
  });
  it('caps research evidence after stable deduplication and keeps the latest eight ordered questions', () => {
    const turns = Array.from({ length: 15 }, (_, id) => research(id));
    turns[3].sources.push(turns[0].sources[0]);
    const option = chatScopeOptions(canvas, view, turns).at(-1)!;
    expect(option).toEqual({ id: 'research', label: 'Research canvas', detail: 'Question 14', context: {
      selectedBlockIds: [], viewMode: 'answer', answerSourceIds: Array.from({ length: 12 }, (_, id) => `source-${id + 3}`),
      answerFocus: { level: 'big-picture', visibleQuestions: turns.slice(-8).map(turn => turn.query), visibleSourceIds: [] },
    } });
    expect(turns[3].sources).toHaveLength(2);
    expect(chatScopeOptions(canvas, view, [research(1, '')]).at(-1)?.detail).toBe('');
  });
  it('keeps active research focus only while viewing the answer canvas', () => {
    expect(chatScopeOptions(canvas, { ...view, viewMode: 'answer', answerFocus: focus }, [research(1)]).at(-1)?.context.answerFocus).toBe(focus);
    expect(chatScopeOptions(canvas, { ...view, viewMode: 'overview', answerFocus: focus }, [research(1)]).at(-1)?.context.answerFocus)
      .toEqual({ level: 'big-picture', visibleQuestions: ['Question 1'], visibleSourceIds: [] });
    expect(chatScopeOptions(canvas, { ...view, viewMode: 'answer' }, [research(1)]).at(-1)?.context.answerFocus)
      .toEqual({ level: 'big-picture', visibleQuestions: ['Question 1'], visibleSourceIds: [] });
  });
  it('protects an unsaved editor across changed scopes and leaves other scope contexts untouched', () => {
    const current = { ...view, editingBlockId: 'qa', editorHasUnsavedChanges: true, editorDraft: draft };
    const options = chatScopeOptions(canvas, current, []);
    expect(requestContextForScope(current, options[0])).toBe(current);
    expect(requestContextForScope(current, options[1])).toEqual({ ...options[1].context, editingBlockId: 'qa', editorHasUnsavedChanges: true });
    expect(requestContextForScope({ ...view, editorHasUnsavedChanges: true }, options[1])).toBe(options[1].context);
    expect(requestContextForScope({ ...current, editorHasUnsavedChanges: false }, options[1])).toBe(options[1].context);
    expect(requestContextForScope({ ...current, editorHasUnsavedChanges: undefined }, options[1])).toBe(options[1].context);
    expect(options[1].context).toEqual({ selectedBlockIds: [], viewMode: 'overview', answerSourceIds: [] });
  });
});

describe('actual chat context selector through native HTTP and installed DeepAgents', () => {
  it('sends the selected scope while retaining the unsaved document guard, reads native source evidence and persists the answer', async () => {
    const setup = await fixture();
    setup.model.handle = (request, response) => {
      if (request.messages.some(message => message.role === 'tool')) { answer(response); return; }
      toolCalls(response, [{ name: 'read_doc', args: { blockId: 'launch-checklist' } }]);
    };
    const base = await setup.app();
    const contexts: ChatViewContext[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/chat/stream') contexts.push(JSON.parse(String(init?.body)).viewContext);
      return nativeFetch(new URL(String(input), base), init);
    });
    const props: AIElementsChatProps = { canvasId: setup.canvas.id, canvas: setup.canvas, answerTurns: [], hasApiKey: true,
      model: setup.settings.model, viewContext: { selectedBlockIds: ['launch-checklist'], editingBlockId: 'launch-checklist',
        editorHasUnsavedChanges: true, editorDraft: { title: 'Unsaved checklist', content: 'Uncommitted draft', kind: 'markdown' } },
      onCanvasChanged: async id => { expect(await setup.store.getCanvas(id)).toEqual(setup.canvas); return { created: [], updated: [] }; },
      onOpenSettings: vi.fn(), onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(),
      onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn() };
    const page = render(<AIElementsChat {...props} />);
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain(setup.canvas.blocks.find(block => block.id === 'launch-checklist')!.title);
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' }));
    fireEvent.click(screen.getByRole('button', { name: /Whole canvas/ }));
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toBe(`Using: ${setup.canvas.name}`);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Read the launch checklist and explain its release gate.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(page.container.querySelector('.ai-chat__answer')?.textContent).toBe('The release requires QA approval.'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(contexts).toEqual([{ selectedBlockIds: [], viewMode: 'overview', answerSourceIds: [], editingBlockId: 'launch-checklist', editorHasUnsavedChanges: true }]);
    expect(setup.model.requests[1].body.messages.find(message => message.role === 'tool')?.content).toContain('The release requires QA approval.');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(window, new Event('pagehide'));
    const saved = localStorage.getItem('symbiknow:chat-history');
    expect(saved).toContain('The release requires QA approval.');
    page.unmount(); render(<AIElementsChat {...props} />);
    await waitFor(() => expect(document.querySelector('.ai-chat__answer')?.textContent).toBe('The release requires QA approval.'));
    expect(await setup.store.getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    expect(setup.model.requests).toHaveLength(2);
  });
});
