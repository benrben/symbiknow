// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerCanvasResult, AnswerCanvasTurn, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import type { AIElementsChatProps } from './chat-types';
import { chatSuggestions } from './chat-suggestions';
import { AIElementsChat } from './AIElementsChat';
import { api } from './api';

const canvas: CanvasDocument = {
  id: 'planning', name: 'Launch planning', workspaceId: 'team', blocks: [
    { id: 'qa', title: 'Mobile QA report', file: 'qa.md', kind: 'markdown', content: '# QA', x: 0, y: 0, width: 300, height: 200, links: [], group: 'custom:launch/qa' },
    { id: 'release', title: 'Release plan', file: 'release.md', kind: 'markdown', content: '# Release', x: 400, y: 0, width: 300, height: 200, links: [], group: 'custom:launch' },
    { id: 'plain', title: 'Ungrouped note', file: 'plain.md', kind: 'markdown', content: '# Note', x: 800, y: 0, width: 300, height: 200, links: [] },
  ]
};
const answer: AnswerCanvasResult = {
  canvasId: canvas.id, query: 'What blocks launch?', selection: 'jev', sources: [
    { canvasId: 'archived', canvasName: 'Earlier evidence', blockId: 'qa', title: 'Saved QA evidence', excerpt: 'Earlier QA', relevance: 1 },
  ]
};
const base: ChatViewContext = { selectedBlockIds: [] };
function focus(extra: Partial<NonNullable<ChatViewContext['answerFocus']>> = {}): NonNullable<ChatViewContext['answerFocus']> { return { level: 'big-picture', visibleQuestions: [], visibleSourceIds: [], ...extra }; }
const exact = (pairs: [string, string][]) => pairs.map(([title, detail]) => ({ title, detail }));
const defaultPrompts = exact([
  ['What matters most in Launch planning?', 'See the most useful documents'], ['Which documents disagree?', 'Find conflicting claims'],
  ['What is missing or outdated?', 'Spot gaps in this canvas'], ['What should the team do next?', 'Use the available documents'],
]);
const sourceCases: { name: string; result?: AnswerCanvasResult | null; current: CanvasDocument | null; id: string; title: string }[] = [
  { name: 'saved source', result: answer, current: canvas, id: 'qa', title: 'Saved QA evidence' },
  { name: 'current source', result: null, current: canvas, id: 'qa', title: 'Mobile QA report' },
  { name: 'missing source', current: canvas, id: 'missing', title: 'this source' },
  { name: 'missing snapshots', result: null, current: null, id: 'qa', title: 'this source' },
  { name: 'empty source title', result: { ...answer, sources: [{ ...answer.sources[0], title: '' }] }, current: canvas, id: 'qa', title: '' },
];

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() { } unobserve() { } disconnect() { } });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

describe('chat suggestion priority and exact public prompts', () => {
  it('prioritizes the focused research block over visible blocks, sources, questions, document selection, drafts and search', () => {
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa', 'release'], viewMode: 'answer', editorDraft: { title: 'Draft', content: '', kind: 'markdown' }, searchQuery: 'Other search', answerFocus: focus({ focusedBlockTitle: 'Risk map', focusedSourceId: 'qa', focusedQuestion: 'Why?', visibleBlockTitles: ['Risk map', 'Plan'], visibleQuestions: ['Why?', 'When?'] }) }, answer)).toEqual(exact([
      ['Expand Risk map', 'Add linked detail to this research block'], ['What evidence supports Risk map?', 'Trace and challenge its citations'], ['Draw the next step from Risk map', 'Extend this part of the map'],
    ]));
  });
  it('prioritizes visible research blocks before selected sources and questions', () => {
    expect(chatSuggestions(canvas, { ...base, viewMode: 'answer', answerFocus: focus({ visibleBlockTitles: ['Risk', 'Plan'], focusedSourceId: 'qa', focusedQuestion: 'Why?' }) }, answer)).toEqual(exact([
      ['How do these visible blocks connect?', 'Explain the structure in view'], ['What is missing between these blocks?', 'Extend the visible part of the map'], ['Which block needs more evidence?', 'Check the citations'],
    ]));
  });
  it.each(sourceCases)('uses the $name title when examining evidence', ({ result, current, id, title }) => {
    expect(chatSuggestions(current, { ...base, viewMode: 'answer', answerFocus: focus({ focusedSourceId: id, focusedQuestion: 'Why?', visibleBlockTitles: ['Only one'] }) }, result)).toEqual(exact([
      [`What does ${title} actually support?`, 'Inspect the selected evidence'], [`What challenges ${title}?`, 'Find counterevidence'], [`What is missing from ${title}?`, 'Find gaps in this source'],
    ]));
  });
  it('prioritizes the focused research question before multi-answer synthesis', () => {
    expect(chatSuggestions(canvas, { ...base, viewMode: 'answer', answerFocus: focus({ focusedQuestion: 'What blocks launch?', visibleQuestions: ['Why?', 'When?'] }) }, answer)).toEqual(exact([
      ['What supports “What blocks launch?”?', 'Trace this answer to sources'], ['Which part of this answer is uncertain?', 'Check the evidence'], ['How does this answer change the plan?', 'Connect it to next actions'],
    ]));
  });
  it('synthesizes visible answers before suggesting source-wide questions', () => {
    expect(chatSuggestions(canvas, { ...base, viewMode: 'answer', answerFocus: focus({ visibleQuestions: ['Why?', 'When?'] }) }, answer)).toEqual(exact([
      ['How do these answers connect?', 'Synthesize the visible answers'], ['Do these answers conflict?', 'Check the evidence across turns'], ['What is the next useful question?', 'Expand the conversation map'],
    ]));
  });
  it('suggests evidence checks from the current research answer before document selection', () => {
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa', 'release'], viewMode: 'answer', answerFocus: focus({ visibleQuestions: ['One question'] }) }, answer)).toEqual(exact([
      ['Which sources disagree?', 'Check the evidence from this answer'], ['What is still unknown?', 'Find gaps in the selected sources'], ['What should we do next?', 'Turn these findings into a plan'],
    ]));
  });
  it('counts only selected documents still present in the canvas and prioritizes multiple selections before editors', () => {
    expect(chatSuggestions(canvas, { selectedBlockIds: ['release', 'qa', 'missing'], editingBlockId: 'qa', editorHasUnsavedChanges: true })).toEqual(exact([
      ['Where do these documents agree or conflict?', '2 selected sources'], ['What is missing between these documents?', 'Find gaps and unresolved questions'], ['What should we do with these findings?', 'Suggest concrete next steps'],
    ]));
    expect(chatSuggestions(canvas, { selectedBlockIds: ['missing', 'qa'] })[0].title).toBe('Explain Mobile QA report in context');
  });
  it.each([true, false, undefined])('protects the editor draft according to the unsaved flag %s', unsaved => {
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa'], readerBlockId: 'release', editingBlockId: 'qa', editorHasUnsavedChanges: unsaved })).toEqual(exact([
      ['Review Mobile QA report for clarity', 'Check structure and wording'], ['What is missing from Mobile QA report?', 'Check gaps against related documents'],
      unsaved ? ['Suggest edits for Mobile QA report without saving', 'Keep your unsaved draft in the editor'] : ['Edit Mobile QA report for clarity', 'Update the saved document'],
    ]));
  });
  it('uses selected, reader or focused documents and preserves canvas order when reader and focus both match', () => {
    const expected = exact([
      ['Explain Mobile QA report in context', 'Connect this document to the canvas'], ['Which documents support or challenge Mobile QA report?', 'Explore related evidence'], ['What should happen next for Mobile QA report?', 'Find useful next actions'],
    ]);
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa'], readerBlockId: 'release', focusBlockId: 'plain', editorDraft: { title: 'Draft', content: '', kind: 'markdown' } })).toEqual(expected);
    expect(chatSuggestions(canvas, { ...base, readerBlockId: 'qa' })).toEqual(expected);
    expect(chatSuggestions(canvas, { ...base, focusBlockId: 'qa' })).toEqual(expected);
    expect(chatSuggestions(canvas, { ...base, readerBlockId: 'release', focusBlockId: 'qa' })).toEqual(expected);
  });
  it('reviews a new unsaved draft before search or group contexts', () => {
    expect(chatSuggestions(null, { ...base, editorDraft: { title: 'Draft', content: 'Unsaved', kind: 'markdown' }, searchQuery: 'QA', activeGroup: 'custom:launch' })).toEqual(exact([
      ['Review this draft', 'Check structure and wording'], ['What is missing from this draft?', 'Find gaps before saving'], ['Suggest a clearer version', 'Keep the changes in chat until you choose them'],
    ]));
  });
  it('trims a search query and prioritizes it before active groups', () => {
    expect(chatSuggestions(canvas, { ...base, searchQuery: '  launch QA  ', activeGroup: 'custom:launch' })).toEqual(exact([
      ['Which sources best answer “launch QA”?', 'Compare the search results'], ['What did this search miss?', 'Look across the workspace'], ['Summarize the strongest evidence', 'Open a temporary answer canvas'],
    ]));
    expect(chatSuggestions(canvas, { ...base, searchQuery: '  ' })).toEqual(defaultPrompts);
  });
  it.each([['custom:launch', 'Launch', 2], ['custom:launch/qa', 'Qa', 1], ['custom:missing', 'Missing', 0]] as const)('counts nested sources for the active group %s', (group, name, count) => {
    expect(chatSuggestions(canvas, { ...base, activeGroup: group, visibleGroups: ['custom:other'] })).toEqual(exact([
      [`What matters most in ${name}?`, `${count} document${count === 1 ? '' : 's'} in this group`], [`Which sources in ${name} disagree?`, 'Compare this part of the canvas'], [`What is missing from ${name}?`, 'Find gaps and next steps'],
    ]));
  });
  it('counts groups without a canvas snapshot and normalizes legacy lane membership', () => {
    expect(chatSuggestions(null, { ...base, activeGroup: 'custom:launch' })[0]).toEqual({ title: 'What matters most in Launch?', detail: '0 documents in this group' });
    expect(chatSuggestions({ ...canvas, blocks: [{ ...canvas.blocks[0], group: 'work' }] }, { ...base, activeGroup: 'lane:work' })[0]).toEqual({ title: 'What matters most in Active work?', detail: '1 document in this group' });
  });
  it.each([{ groups: ['custom:launch'] }, { groups: ['custom:launch', 'custom:other', 'custom:hidden'] }])('names at most two visible groups but reports the full visible count: %j', ({ groups }) => {
    expect(chatSuggestions(canvas, { ...base, viewMode: 'overview', visibleGroups: groups })).toEqual(exact([
      [`How do ${groups.length === 1 ? 'Launch' : 'Launch and Other'} connect?`, `${groups.length} visible group${groups.length === 1 ? '' : 's'}`], ['Which visible group needs attention?', 'Compare the groups in view'], ['What is missing between these groups?', 'Find cross-group gaps'],
    ]));
  });
  it('keeps answer focus out of ordinary document mode and suppresses group prompts there', () => {
    expect(chatSuggestions(canvas, { ...base, viewMode: 'documents', answerFocus: focus({ focusedBlockTitle: 'Research', focusedSourceId: 'qa', focusedQuestion: 'Why?', visibleQuestions: ['Why?', 'When?'], visibleBlockTitles: ['First', 'Second'] }), visibleGroups: ['custom:launch'] })).toEqual(defaultPrompts);
    expect(chatSuggestions(canvas, { ...base, visibleGroups: [] })).toEqual(defaultPrompts);
  });
  it('uses conversation evidence outside research mode, before falling back to an empty canvas', () => {
    expect(chatSuggestions(null, base, answer)).toEqual(exact([
      ['Which sources disagree?', 'Compare evidence from our conversation'], ['What is still unknown?', 'Find gaps in our conversation'], ['What should we do next?', 'Turn the answers into a plan'],
    ]));
  });
  it.each([null, { ...canvas, blocks: [] }])('offers starting prompts when the canvas snapshot is empty: %j', current => {
    expect(chatSuggestions(current, { ...base, viewMode: 'answer' }, { ...answer, sources: [] })).toEqual(exact([
      ['Help me plan this canvas', 'Start with goals and sources'], ['What should I add first?', 'Get a practical starting point'],
    ]));
  });
  it('preserves all four general prompts when no more specific context exists', () => { expect(chatSuggestions(canvas, base)).toEqual(defaultPrompts); });
  it('preserves exact short and boundary-length titles, trims truncated whitespace, and truncates long Unicode labels', () => {
    const title = '界'.repeat(50);
    const current = { ...canvas, name: title, blocks: [{ ...canvas.blocks[0], title }] };
    expect(chatSuggestions(current, { selectedBlockIds: ['qa'] })[0].title).toBe('Explain ' + '界'.repeat(39) + '… in context');
    expect(chatSuggestions({ ...canvas, name: 'x'.repeat(42) }, base)[0].title).toBe('What matters most in ' + 'x'.repeat(42) + '?');
    expect(chatSuggestions({ ...canvas, name: 'x'.repeat(38) + '     suffix' }, base)[0].title).toBe('What matters most in ' + 'x'.repeat(38) + '…?');
  });
});

describe('chat suggestion readable title regressions', () => {
  it('does not split a Unicode surrogate pair at the focused research title boundary', () => {
    const title = 'A'.repeat(38) + '🚀' + ' more evidence';
    const suggestions = chatSuggestions(canvas, { ...base, viewMode: 'answer', answerFocus: focus({ focusedBlockTitle: title }) });
    expect(suggestions[0].title).not.toMatch(/\p{Surrogate}/u);
    expect(suggestions[0].title).toBe('Expand ' + 'A'.repeat(38) + '…');
  });
  it('retains a complete Unicode pair when the boundary follows its low surrogate', () => {
    const title = 'A'.repeat(37) + '🚀' + ' more evidence';
    expect(chatSuggestions({ ...canvas, name: title }, base)[0].title).toBe('What matters most in ' + 'A'.repeat(37) + '🚀…?');
  });
  it('uses the readable Ungrouped title for sources outside a named group', () => {
    expect(chatSuggestions(canvas, { ...base, activeGroup: '__ungrouped' })[0]).toEqual({ title: 'What matters most in Ungrouped?', detail: '1 document in this group' });
    expect(chatSuggestions(canvas, { ...base, viewMode: 'overview', visibleGroups: ['__ungrouped', 'custom:launch'] })[0].title).toBe('How do Ungrouped and Launch connect?');
  });
});

function chatProps(overrides: Partial<AIElementsChatProps> = {}): AIElementsChatProps {
  return {
    canvasId: canvas.id, canvas, viewContext: base, answerTurns: [], hasApiKey: true, model: 'test-model',
    onOpenSettings: vi.fn(),
    onCanvasChanged: vi.fn(async id => {
      const refreshed = await api<CanvasDocument>('/canvases/' + id);
      expect(refreshed.blocks).toEqual(canvas.blocks);
      return { created: [], updated: [] };
    }),
    onShowBlock: vi.fn(), onNavigate: vi.fn(), onReturnNavigation: vi.fn(),
    onUndoCreatedBlock: vi.fn(), onUndoEditedBlock: vi.fn(), onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(),
    onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn(), ...overrides,
  };
}
type SubmittedChat = { canvasId: string; messages: { role: string; content: string }[]; viewContext: ChatViewContext };
function boundary(reply: () => Response | Promise<Response> = () => new Response('data: {"choices":[{"delta":{"content":"Evidence reply"}}]}\n\ndata: [DONE]\n\n')) {
  const submitted: SubmittedChat[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/canvases/planning') return Response.json(canvas);
    if (String(input) !== '/api/chat/stream') throw new Error('Unexpected request ' + String(input));
    submitted.push(JSON.parse(String(init?.body)) as SubmittedChat);
    return reply();
  }));
  return submitted;
}
function starters() { return within(screen.getByRole('group', { name: 'Suggested questions' })); }
const researchTurns: AnswerCanvasTurn[] = [{ id: 8, query: answer.query, answer: 'Previous answer', sources: answer.sources, status: 'complete', selection: 'jev' }];
const uiCases: { name: string; context: ChatViewContext; prompt: string; detail: string; turns?: AnswerCanvasTurn[] }[] = [
  { name: 'focused research block', context: { ...base, viewMode: 'answer', answerFocus: focus({ focusedBlockTitle: 'Risk map' }) }, prompt: 'Expand Risk map', detail: 'Add linked detail to this research block' },
  { name: 'saved answer source', context: { ...base, viewMode: 'answer', answerFocus: focus({ focusedSourceId: 'qa' }) }, turns: researchTurns, prompt: 'What does Saved QA evidence actually support?', detail: 'Inspect the selected evidence' },
  { name: 'document selection', context: { selectedBlockIds: ['qa', 'release'] }, prompt: 'Where do these documents agree or conflict?', detail: '2 selected sources' },
  { name: 'unsaved document editor', context: { selectedBlockIds: ['qa'], editingBlockId: 'qa', editorHasUnsavedChanges: true }, prompt: 'Review Mobile QA report for clarity', detail: 'Check structure and wording' },
  { name: 'trimmed search', context: { ...base, searchQuery: '  launch QA  ' }, prompt: 'Which sources best answer “launch QA”?', detail: 'Compare the search results' },
  { name: 'nested group', context: { ...base, activeGroup: 'custom:launch' }, prompt: 'What matters most in Launch?', detail: '2 documents in this group' },
];

describe('suggestions through the owning assistant browser UI', () => {
  it.each(uiCases)('submits the exact $name prompt and current scope, then retains it in browser history', async ({ context, prompt, detail, turns }) => {
    const submitted = boundary();
    const current = chatProps({ viewContext: context, answerTurns: turns ?? [] });
    const ui = render(<AIElementsChat {...current} />);
    const buttons = starters().getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(within(buttons[0]).getByText(prompt, { exact: true })).toBeTruthy();
    expect(within(buttons[0]).getByText(detail, { exact: true })).toBeTruthy();
    fireEvent.click(buttons[0]);
    await screen.findByText('Evidence reply');
    const followups = within(await screen.findByRole('group', { name: 'Suggested follow-up questions' })).getAllByRole('button');
    expect(followups).toHaveLength(2);
    expect(followups[0].textContent).toBe(prompt);
    expect(submitted).toEqual([{ canvasId: canvas.id, messages: [{ role: 'user', content: prompt }], viewContext: context }]);
    expect(current.onCanvasChanged).toHaveBeenCalledWith(canvas.id, canvas.blocks);
    fireEvent(window, new Event('pagehide'));
    const history = JSON.parse(localStorage.getItem('symbiknow:chat-history') ?? 'null') as { role: string; content: string }[];
    expect(history.map(({ role, content }) => ({ role, content }))).toEqual([{ role: 'user', content: prompt }, { role: 'assistant', content: 'Evidence reply' }]);
    ui.unmount();
    render(<AIElementsChat {...current} />);
    expect(within(screen.getByRole('log')).getByText(prompt)).toBeTruthy();
    expect(screen.getByText('Evidence reply')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Suggested follow-up questions' })).getAllByRole('button')).toHaveLength(2);
    expect(submitted).toHaveLength(1);
  });
  it('updates visible suggestions when the view changes and preserves the unsaved editor guard when using the whole canvas', async () => {
    const submitted = boundary();
    const original = chatProps({ viewContext: { selectedBlockIds: ['qa'], editingBlockId: 'qa', editorHasUnsavedChanges: true } });
    const ui = render(<AIElementsChat {...original} />);
    expect(starters().getByText('Suggest edits for Mobile QA report without saving')).toBeTruthy();
    ui.rerender(<AIElementsChat {...original} viewContext={{ ...base, viewMode: 'overview', visibleGroups: ['__ungrouped', 'custom:launch'] }} />);
    expect(starters().getByText('How do Ungrouped and Launch connect?')).toBeTruthy();
    ui.rerender(<AIElementsChat {...original} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' }));
    fireEvent.click(screen.getByRole('button', { name: /Whole canvas/ }));
    expect(starters().getAllByRole('button')).toHaveLength(3);
    fireEvent.click(starters().getAllByRole('button')[0]);
    await screen.findByRole('group', { name: 'Suggested follow-up questions' });
    expect(submitted[0]).toEqual({ canvasId: canvas.id, messages: [{ role: 'user', content: 'What matters most in Launch planning?' }], viewContext: { selectedBlockIds: [], viewMode: 'overview', answerSourceIds: [], editingBlockId: 'qa', editorHasUnsavedChanges: true } });
  });
  it('never starts a second suggestion while a response is pending and uses the latest view for the next follow-up', async () => {
    let resolveReply!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { resolveReply = resolve; });
    let replies = 0;
    const submitted = boundary(() => ++replies === 1 ? response : new Response('data: {"choices":[{"delta":{"content":"Second reply"}}]}\n\ndata: [DONE]\n\n'));
    const current = chatProps();
    const ui = render(<AIElementsChat {...current} />);
    fireEvent.click(starters().getAllByRole('button')[0]);
    expect(screen.queryByRole('group', { name: 'Suggested follow-up questions' })).toBeNull();
    ui.rerender(<AIElementsChat {...current} viewContext={{ ...base, searchQuery: 'QA' }} />);
    expect(submitted).toHaveLength(1);
    await act(async () => resolveReply(new Response('data: {"choices":[{"delta":{"content":"First reply"}}]}\n\ndata: [DONE]\n\n')));
    const followups = within(await screen.findByRole('group', { name: 'Suggested follow-up questions' }));
    expect(followups.getAllByRole('button')[0].textContent).toBe('Which sources best answer “QA”?');
    fireEvent.click(followups.getAllByRole('button')[0]);
    await screen.findByRole('group', { name: 'Suggested follow-up questions' });
    expect(submitted).toHaveLength(2);
    expect(submitted[1].viewContext).toEqual({ ...base, searchQuery: 'QA' });
    expect(submitted[1].messages.at(-1)?.content).toBe('Which sources best answer “QA”?');
  });
  it('retains the exact suggested question through an HTTP error and a public retry', async () => {
    let attempts = 0;
    const submitted = boundary(() => ++attempts === 1 ? Response.json({ error: 'Research service is busy' }, { status: 503 }) : new Response('data: {"choices":[{"delta":{"content":"Recovered evidence"}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...chatProps({ viewContext: { ...base, activeGroup: '__ungrouped' } })} />);
    fireEvent.click(starters().getAllByRole('button')[0]);
    expect((await screen.findByRole('alert')).textContent).toContain('Research service is busy');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered evidence');
    await screen.findByRole('group', { name: 'Suggested follow-up questions' });
    expect(submitted).toHaveLength(2);
    expect(submitted[1].messages).toEqual([{ role: 'user', content: 'What matters most in Ungrouped?' }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('requires a canvas and a connected provider before a suggestion can send a request', async () => {
    const submitted = boundary();
    const current = chatProps({ canvasId: '', canvas: null });
    const ui = render(<AIElementsChat {...current} />);
    fireEvent.click(starters().getAllByRole('button')[0]);
    expect(screen.getByRole('alert').textContent).toContain('Open a canvas before using the assistant.');
    expect(submitted).toHaveLength(0);
    ui.rerender(<AIElementsChat {...current} canvasId={canvas.id} canvas={canvas} hasApiKey={false} />);
    fireEvent.click(starters().getAllByRole('button')[0]);
    expect(screen.getByRole('alert').textContent).toContain('Connect a chat model in Settings before using the assistant.');
    expect(submitted).toHaveLength(0);
    expect(current.onOpenSettings).toHaveBeenCalledOnce();
    ui.rerender(<AIElementsChat {...current} canvasId={canvas.id} canvas={canvas} hasApiKey />);
    fireEvent.click(starters().getAllByRole('button')[0]);
    await waitFor(() => expect(submitted).toHaveLength(1));
    await screen.findByRole('group', { name: 'Suggested follow-up questions' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
