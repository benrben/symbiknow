// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIElementsChat } from './AIElementsChat';
import { chatHistoryKey } from './chat-history';
import type { AIElementsChatProps, Activity, DisplayTurn } from './chat-types';
import type { CanvasEdit } from './canvas-changes';
import type { SymbiState } from './SymbiAvatar';
import {
  activeToolState, activityStatus, editPreview, errorText, finishActivity,
  resetAssistant, restoredTurns, settledAssistant, updatedActivity,
  updatedAssistant,
} from './chat-turn-state';

const user: DisplayTurn = { id: 1, role: 'user', content: 'Keep the release question', activities: [] };
const assistant: DisplayTurn = { id: 3, role: 'assistant', content: 'Keep the verified release answer', activities: [] };
const tool: Activity = { key: 1, type: 'tool', id: 'read-1', name: 'read_doc', message: 'Reading the checklist', status: 'active' };
const thinking: Activity = { key: 2, type: 'thinking', message: 'Checking the evidence', status: 'active' };
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

function save(value: unknown) { localStorage.setItem(chatHistoryKey, JSON.stringify(value)); }
function turn(activities: Activity[] = [], content = ''): DisplayTurn { return { ...assistant, activities, content }; }
function props(): AIElementsChatProps {
  return { canvasId: 'product-roadmap', canvas: null, viewContext: { selectedBlockIds: [] }, answerTurns: [],
    hasApiKey: true, model: 'native-session', onOpenSettings: vi.fn(), onCanvasChanged: vi.fn(),
    onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(),
    onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(),
    onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn() };
}
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

describe('chat history recovery through public storage and the actual chat view', () => {
  it('starts empty for missing history, malformed JSON and non-array saved values', () => {
    expect(restoredTurns()).toEqual([]);
    localStorage.setItem(chatHistoryKey, '{'); expect(restoredTurns()).toEqual([]);
    save({ turns: [user] }); expect(restoredTurns()).toEqual([]);
  });
  it('filters invalid turn and activity fields while retaining original optional review metadata', () => {
    const badTurns = [null, false, 'text', {}, { ...user, role: 'system' }, { ...user, content: 7 },
      { ...user, id: 1.5 }, { ...user, activities: null }];
    const badActivities = [null, 'tool', {}, { ...tool, key: '1' }, { ...tool, type: 'other' },
      { ...tool, id: 1 }, { ...tool, name: 1 }, { ...tool, message: null }, { ...tool, status: 'pending' }];
    const reviewed = { ...assistant, verification: { status: 'supported' as const },
      mergeDraft: { keepBlockId: 'qa', mergeBlockIds: ['release'], intentToken: 'keep-original' } };
    save([...badTurns, ...badActivities.map(activity => ({ ...assistant, id: 2, activities: [activity] })), user, reviewed]);
    expect(restoredTurns()).toEqual([user, reviewed]);
  });
  it('restores only the last sixty valid turns and settles interrupted tools without changing completed activity', () => {
    const history = Array.from({ length: 65 }, (_, id) => ({ ...user, id }));
    const resumed = { ...assistant, id: 70, activities: [thinking, tool, { ...tool, key: 5, status: 'complete' as const }] };
    save([...history, resumed]);
    expect(restoredTurns()).toEqual([...history.slice(6), { ...resumed, activities: [
      { ...thinking, status: 'stopped' }, { ...tool, status: 'stopped' }, resumed.activities[2],
    ] }]);
    save([{ ...user, id: -1 }, { ...user, id: 2 ** 54 }]);
    expect(restoredTurns()).toEqual([{ ...user, id: -1 }, { ...user, id: 2 ** 54 }]);
  });
  it('preserves valid turns when another saved turn has a null activity', () => {
    save([user, { ...assistant, id: 2, activities: [null] }, assistant]);
    expect(restoredTurns()).toEqual([user, assistant]);
  });
  it('rejects an activity whose message cannot be rendered as text', () => {
    save([user, { ...assistant, id: 2, activities: [{ ...tool, message: { broken: true } }] }, assistant]);
    expect(restoredTurns()).toEqual([user, assistant]);
  });
  it('keeps the usable saved conversation visible and persisted after mounting and remounting', async () => {
    save([user, { ...assistant, id: 2, activities: [null] }, assistant]);
    const first = render(<AIElementsChat {...props()} />);
    expect(await screen.findByText(user.content)).toBeTruthy();
    expect(screen.getByText(assistant.content)).toBeTruthy();
    fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(chatHistoryKey)!)).toEqual([user, assistant]);
    first.unmount(); render(<AIElementsChat {...props()} />);
    expect(await screen.findByText(assistant.content)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Symbi' })).toBeTruthy());
  });
});

describe('public turn transitions and presentation', () => {
  const categories: Array<[string, SymbiState]> = [
    ['search_docs', 'searching'], ['search_canvas', 'searching'],
    ['read_doc', 'reading'], ['read_block', 'reading'], ['read_file', 'reading'],
    ['show_doc_on_canvas', 'moving'], ['show_group_on_canvas', 'moving'],
    ['move_block', 'moving'], ['create_doc', 'writing'], ['edit_doc', 'writing'],
    ['delete_doc', 'writing'], ['link_blocks', 'connecting'],
    ['draw_research_canvas', 'organizing'], ['remote_tool', 'tooling'],
  ];
  it.each(categories)('maps active %s to %s without mutating saved activities', (name, expected) => {
    const activities = [thinking, { ...tool, name }];
    expect(activeToolState(turn(activities))).toBe(expected);
    expect(activities).toEqual([thinking, { ...tool, name }]);
  });
  it('uses the latest active tool, skips completed tools and handles absent names or activity', () => {
    expect(activeToolState()).toBeNull(); expect(activeToolState(turn())).toBeNull();
    expect(activeToolState(turn([thinking]))).toBeNull();
    expect(activeToolState(turn([{ ...tool, status: 'complete' }]))).toBeNull();
    expect(activeToolState(turn([tool, { ...tool, name: 'search_docs', key: 3 }, { ...tool, key: 4, status: 'stopped' }]))).toBe('searching');
    expect(activeToolState(turn([{ ...tool, name: undefined }]))).toBe('tooling');
  });
  const messages: Array<[SymbiState, string | null]> = [
    ['searching', 'Searching documents…'], ['reading', 'Reading the source…'], ['working', 'Updating the canvas…'],
    ['navigating', 'Opening the right place…'], ['tooling', 'Working with a tool…'],
    ['moving', 'Opening the right place…'], ['writing', 'Preparing changes…'],
    ['connecting', 'Connecting documents…'], ['organizing', 'Organizing the research canvas…'],
    ['listening', 'Receiving your request…'], ['asking', 'Waiting for your decision…'],
    ['checking', 'Checking the connection…'],
    ['idle', null], ['thinking', null], ['speaking', null], ['done', null], ['error', null],
  ];
  it.each(messages)('preserves the exact activity label for %s', (state, expected) => { expect(activityStatus(state)).toBe(expected); });
  it('exposes an Error message and supplies recoverable text for other failures', () => {
    expect(errorText(new Error('Native store unavailable'))).toBe('Native store unavailable');
    expect(errorText({ reason: 'offline' })).toBe('Something went wrong. Please try again.');
  });
  it('stops active tools, completes thinking only on success and preserves settled entries', () => {
    const complete = { ...tool, key: 3, status: 'complete' as const };
    const stopped = { ...thinking, key: 4, status: 'stopped' as const };
    const activities = [thinking, tool, complete, stopped];
    expect(finishActivity(activities, 'complete')).toEqual([{ ...thinking, status: 'complete' }, { ...tool, status: 'stopped' }, complete, stopped]);
    expect(finishActivity(activities, 'stopped')).toEqual([{ ...thinking, status: 'stopped' }, { ...tool, status: 'stopped' }, complete, stopped]);
    expect(activities).toEqual([thinking, tool, complete, stopped]);
  });
  it('appends answer chunks, settles the matching turn without changing neighbors', () => {
    const turns = [user, turn([thinking, tool], 'Release ')];
    const updated = updatedAssistant(turns, 3, 'ready');
    expect(updated).toEqual([user, turn([{ ...thinking, status: 'complete' }, tool], 'Release ready')]);
    expect(updatedAssistant(turns, 99, 'Orphan')).toEqual(turns);
    expect(settledAssistant(turns, 3, 'stopped')).toEqual([user, turn([{ ...thinking, status: 'stopped' }, { ...tool, status: 'stopped' }], 'Release ')]);
    expect(settledAssistant(turns, 99, 'complete')).toEqual(turns);
  });
  it('moves a pre-tool answer into completed activity, normalizes whitespace and caps the note', () => {
    expect(resetAssistant([user, turn([thinking, tool], ' \n Review   the source.\t ')], 3, 5)).toEqual([user, turn([
      { ...thinking, status: 'complete' }, tool, { key: 5, type: 'thinking', message: 'Review the source.', status: 'complete' },
    ])]);
    expect(resetAssistant([user, turn([], 'x'.repeat(221))], 3, 6)[1].activities).toEqual([{ key: 6, type: 'thinking', message: 'x'.repeat(217) + '…', status: 'complete' }]);
    expect(resetAssistant([user, turn([], 'x'.repeat(220))], 3, 6)[1].activities[0].message).toBe('x'.repeat(220));
    expect(resetAssistant([user, turn([tool], ' \t ')], 3, 6)).toEqual([user, turn([tool])]);
    expect(resetAssistant([user, assistant], 99, 6)).toEqual([user, assistant]);
  });
});

describe('public streamed tool activity matching', () => {
  it('deduplicates thinking while preserving a later different message and finishing the preceding one', () => {
    const turns = [user, turn()];
    const first = updatedActivity(turns, 3, { type: 'thinking', message: thinking.message }, 2);
    expect(first).toEqual([user, turn([thinking])]);
    expect(updatedActivity(first, 3, { type: 'thinking', message: thinking.message }, 99)).toBe(first);
    expect(updatedActivity(first, 3, { type: 'thinking', message: 'Another source' }, 3)).toEqual([user, turn([
      { ...thinking, status: 'complete' }, { key: 3, type: 'thinking', message: 'Another source', status: 'active' },
    ])]);
    expect(updatedActivity(turns, 99, { type: 'thinking', message: 'Orphan' }, 7)).toBe(turns);
  });
  it('matches repeated tool starts by ID before name and skips intervening thinking for adjacent names', () => {
    const start = { type: 'tool_start' as const, id: tool.id, name: tool.name, message: tool.message };
    const first = updatedActivity([user, turn([thinking])], 3, start, 1);
    expect(first).toEqual([user, turn([{ ...thinking, status: 'complete' }, tool])]);
    expect(updatedActivity(first, 3, { ...start, name: 'different' }, 9)).toBe(first);
    const adjacent = [user, turn([tool, thinking])];
    expect(updatedActivity(adjacent, 3, { ...start, id: undefined }, 9)).toBe(adjacent);
    const next = updatedActivity(adjacent, 3, { ...start, id: 'new-id' }, 3);
    expect(next[1].activities.at(-1)).toEqual({ ...tool, id: 'new-id', key: 3 });
    expect(updatedActivity(adjacent, 3, { ...start, id: undefined, name: 'other' }, 3)[1].activities.at(-1)?.name).toBe('other');
    expect(updatedActivity([turn([thinking])], 3, { type: 'tool_start', name: 'read_doc', message: 'Start' }, 3)[0].activities).toHaveLength(2);
    expect(updatedActivity([turn()], 3, { type: 'tool_start', message: 'Unnamed start' }, 3)[0].activities[0]).toMatchObject({ name: undefined, id: undefined, status: 'active' });
  });
  it('completes the latest matching ID, deduplicates identical completions and retains unmatched end events', () => {
    const turns = [user, turn([tool, { ...tool, key: 3, message: 'Second execution' }, thinking])];
    const end = { type: 'tool_end' as const, id: tool.id, name: tool.name, message: 'Finished read_doc' };
    const completed = updatedActivity(turns, 3, end, 8);
    expect(completed[1].activities).toEqual([tool, { ...tool, key: 3, message: end.message, status: 'complete' }, { ...thinking, status: 'complete' }]);
    expect(updatedActivity(completed, 3, end, 9)).toBe(completed);
    expect(updatedActivity(completed, 3, { ...end, message: 'Updated result' }, 10)[1].activities[1].message).toBe('Updated result');
    expect(updatedActivity(turns, 3, { ...end, id: undefined }, 8)[1].activities[1].status).toBe('complete');
    expect(updatedActivity([turn([thinking])], 3, { ...end, id: undefined }, 8)[0].activities.at(-1)).toMatchObject({ key: 8, status: 'complete', name: tool.name });
    expect(updatedActivity([turn([tool])], 3, { type: 'tool_end', name: 'other', message: 'Other result' }, 8)[0].activities).toHaveLength(2);
    expect(updatedActivity([turn()], 3, { type: 'tool_end', message: 'Unnamed result' }, 8)[0].activities[0]).toMatchObject({ key: 8, status: 'complete', id: undefined, name: undefined });
    expect(updatedActivity([turn([tool])], 3, { ...end, id: 'missing' }, 8)[0].activities).toHaveLength(2);
  });
});

describe('public review excerpts and Markdown draft boundaries', () => {
  const block = { id: 'qa', file: 'qa.md', title: 'QA', kind: 'markdown' as const, content: 'The release is blocked.', x: 0, y: 0, width: 300, height: 200, links: [] };
  function edit(before: string, after: string): CanvasEdit { return { before: { ...block, content: before }, after: { ...block, content: after } }; }
  it('reports changed fields in their original order and uses document details for an unchanged snapshot', () => {
    expect(editPreview({ before: block, after: { ...block } })).toEqual({ fields: 'document details', before: block.content, after: block.content });
    const changed: CanvasEdit = { before: block, after: { ...block, title: 'Reviewed', content: 'Ready', kind: 'slides', group: 'qa', links: ['release'], x: 3, y: 4, tags: ['release'] } };
    expect(editPreview(changed)).toEqual({ fields: 'title, content, kind, group, links, x, y, tags', before: block.content, after: 'Ready' });
  });
  it('shows bounded context around a late edit and handles prefixes, empty text and independent trailing ellipses', () => {
    const prefix = 'a'.repeat(100);
    expect(editPreview(edit(prefix + 'b'.repeat(300), prefix + 'changed'))).toEqual({ fields: 'content', before: '…' + 'a'.repeat(60) + 'b'.repeat(180) + '…', after: '…' + 'a'.repeat(60) + 'changed' });
    expect(editPreview(edit('Ready', 'Ready now'))).toEqual({ fields: 'content', before: 'Ready', after: 'Ready now' });
    expect(editPreview(edit('', 'New source'))).toEqual({ fields: 'content', before: '', after: 'New source' });
    expect(editPreview(edit('x'.repeat(300), 'z'.repeat(300)))).toEqual({ fields: 'content', before: 'x'.repeat(240) + '…', after: 'z'.repeat(240) + '…' });
  });
});
