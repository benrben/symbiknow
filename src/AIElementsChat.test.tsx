// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIElementsChat } from './AIElementsChat';
import type { CanvasBlock } from '../shared/types';
import type { CanvasEdit } from './canvas-changes';

function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    body,
    push(value: string) { controller.enqueue(encoder.encode(value)); },
    fail(reason: unknown) { controller.error(reason); },
  };
}

function viewProps() {
  return { canvasId: 'planning', canvas: null, viewContext: { selectedBlockIds: [] }, answerTurns: [], hasApiKey: true,
    model: 'openai/gpt-4o-mini', onOpenSettings: vi.fn(),
    onCanvasChanged: vi.fn(async () => ({ created: [] as CanvasBlock[], updated: [] as CanvasEdit[] })), onShowBlock: vi.fn(), onNavigate: vi.fn(),
    onReturnNavigation: vi.fn(), onUndoCreatedBlock: vi.fn(async () => undefined), onUndoEditedBlock: vi.fn(async () => undefined),
    onCanvasSources: vi.fn(), onCanvasPatch: vi.fn(), onCanvasAnswer: vi.fn(), onCanvasTurnEnd: vi.fn(), onOpenAnswerCanvas: vi.fn() };
}

function send(message: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
}

function activityPanel() {
  return screen.getByRole('region', { name: 'Agent activity' });
}

function activityButton() {
  return within(activityPanel()).getByRole('button');
}

beforeEach(() => {
  window.sessionStorage.removeItem('symbiknow:chat-draft');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AI Elements agent activity', () => {
  it('shows the current document and sends an explicit whole-canvas scope', async () => {
    const block: CanvasBlock = { id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: 'Tests failed',
      x: 0, y: 0, width: 300, height: 200, links: [] };
    const props = { ...viewProps(), canvas: { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [block] },
      viewContext: { selectedBlockIds: ['qa'], viewMode: 'documents' as const } };
    vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'));
    render(<AIElementsChat {...props}/>);
    expect(screen.getByRole('button', { name: 'Choose assistant context' }).textContent).toContain('QA report');
    fireEvent.click(screen.getByRole('button', { name: 'Choose assistant context' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Assistant context options' })).getByRole('button', { name: /Whole canvas/ }));
    send('What changed?');
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(request.viewContext).toMatchObject({ selectedBlockIds: [], viewMode: 'overview' });
  });

  it('lets the user turn a direct answer into a research map', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Two tests failed."}}]}\n\ndata: [DONE]\n\n'))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    render(<AIElementsChat {...viewProps()}/>);
    send('Which tests failed?');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn this into a map' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(request.messages.at(-1).content).toBe('Create a temporary research canvas for: Which tests failed?');
  });

  it('shows where the agent navigated and provides a way back', async () => {
    const props = viewProps();
    vi.mocked(fetch).mockResolvedValue(new Response('event: canvas_navigation\ndata: {"kind":"document","canvasId":"planning","blockId":"qa","title":"QA report"}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...props}/>);
    send('Show the QA report');
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'document', canvasId: 'planning', blockId: 'qa', title: 'QA report' });
    expect(props.onReturnNavigation).toHaveBeenCalledOnce();
  });

  it('asks where to work and lets the user choose the current view without opening research', async () => {
    const choice = { question: 'Help me with this?', options: [
      { label: 'Build a research canvas', detail: 'Map evidence', prompt: 'Create a temporary research canvas for: Help me with this?' },
      { label: 'Work on this view', detail: 'Use the current document', prompt: 'Answer in chat using what I am viewing: Help me with this?' },
      { label: 'Take me to the source', detail: 'Navigate', prompt: 'Navigate to the right document for: Help me with this?' },
    ] };
    const props = viewProps();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`event: presentation_choice\ndata: ${JSON.stringify(choice)}\n\ndata: {"choices":[{"delta":{"content":"Where should I work?"}}]}\n\ndata: [DONE]\n\n`))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Here is the answer."}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...props}/>);
    send(choice.question);
    const currentView = await screen.findByRole('button', { name: /Work on this view/ });
    await waitFor(() => expect((currentView as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(currentView);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: choice.options[1].prompt });
    expect(props.onCanvasSources).not.toHaveBeenCalled();
    expect(props.onCanvasPatch).not.toHaveBeenCalled();
  });

  it('submits external prompts once per sequence through the chat stream', async () => {
    const props = viewProps();
    vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'));
    const { rerender } = render(<AIElementsChat {...props} promptRequest={{ text: 'Summarize selected documents', sequence: 1 }}/>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Summarize selected documents')).toBeTruthy();
    rerender(<AIElementsChat {...props} promptRequest={{ text: 'Summarize selected documents', sequence: 1 }}/>);
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<AIElementsChat {...props} promptRequest={{ text: 'Compare selected documents', sequence: 2 }}/>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Compare selected documents')).toBeTruthy();
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Compare selected documents' });
  });

  it('streams a merge preview and returns the complete fenced Markdown without applying it', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    const props = viewProps();
    const onMergeDraft = vi.fn();
    render(<AIElementsChat {...props} onMergeDraft={onMergeDraft} promptRequest={{
      text: 'Draft a merge of two setup guides', sequence: 1, mergeDraft: { keepBlockId: 'guide', mergeBlockIds: ['old-guide'] },
    }}/>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ previewMerge: true,
      messages: [{ role: 'user', content: 'Draft a merge of two setup guides' }] });

    const markdown = '# Merged guide\n\nKeep this section.\n\n```bash\nnpm install\n```\n\n## Open questions\n- Which version is current?';
    await act(async () => { stream.push(`data: ${JSON.stringify({ choices: [{ delta: { content: `Here is the draft:\n\n\`\`\`\`markdown\n${markdown}\n\`\`\`\`\nReview it before applying.` } }] })}\n\n`); });
    expect(onMergeDraft).not.toHaveBeenCalled();
    await act(async () => { stream.push('data: [DONE]\n\n'); });

    await waitFor(() => expect(onMergeDraft).toHaveBeenCalledWith(markdown, { keepBlockId: 'guide', mergeBlockIds: ['old-guide'] }));
    expect(props.onCanvasChanged).not.toHaveBeenCalled();
    expect(screen.getByText('Here is the draft:')).toBeTruthy();
  });

  it('discards the merge intent token after a preview attempt before retrying', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('event: error\ndata: {"message":"Draft interrupted"}\n\n'))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    render(<AIElementsChat {...viewProps()} promptRequest={{ text: 'Draft merge', sequence: 1,
      mergeDraft: { keepBlockId: 'guide', mergeBlockIds: ['notes'], intentToken: 'one-time-token' } }}/>);
    await screen.findByText('Draft interrupted');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ previewMerge: true, intentToken: 'one-time-token' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const retry = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(retry.previewMerge).toBe(true);
    expect(retry.intentToken).toBeUndefined();
  });

  it('waits for a canvas and chat key before sending an external prompt', async () => {
    const props = viewProps();
    vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'));
    const request = { text: 'Summarize selected documents', sequence: 11 };
    const { rerender } = render(<AIElementsChat {...props} canvasId="" hasApiKey={false} promptRequest={request}/>);
    expect(fetch).not.toHaveBeenCalled();
    rerender(<AIElementsChat {...props} hasApiKey={false} promptRequest={request}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Connect a chat model in Settings');
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    rerender(<AIElementsChat {...props} promptRequest={request}/>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Summarize selected documents')).toBeTruthy();
  });

  it('keeps an external prompt queued during an active reply', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream.body)).mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    const props = viewProps();
    const { rerender } = render(<AIElementsChat {...props}/>);
    send('First request');
    rerender(<AIElementsChat {...props} promptRequest={{ text: 'Summarize selected documents', sequence: 1 }}/>);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { stream.push('data: [DONE]\n\n'); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Summarize selected documents')).toBeTruthy();
  });

  it('links assistant-created documents back to their canvas card', async () => {
    const props = viewProps();
    const block = { id: 'new', title: 'Launch plan', file: 'docs/new.md', kind: 'markdown' as const, content: '# Launch plan', x: 532, y: 100, width: 400, height: 320, links: [] };
    props.onCanvasChanged.mockResolvedValue({ created: [block], updated: [] });
    vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Created the plan."}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...props}/>);
    send('Create the plan');
    fireEvent.click(await screen.findByRole('button', { name: 'Show Launch plan on canvas' }));
    expect(props.onShowBlock).toHaveBeenCalledWith(block, 'planning');
    fireEvent.click(screen.getByRole('button', { name: 'Undo creation' }));
    await waitFor(() => expect(props.onUndoCreatedBlock).toHaveBeenCalledWith('planning', block));
    expect(await screen.findByText('Undid creation of Launch plan.')).toBeTruthy();
  });

  it('shows a reviewed edit and lets the user undo that edit', async () => {
    const prefix = 'Background details. '.repeat(20);
    const before: CanvasBlock = { id: 'qa', title: 'QA report', file: 'qa.md', kind: 'markdown', content: `${prefix}Old result`,
      x: 100, y: 100, width: 300, height: 180, links: [] };
    const after = { ...before, content: `${prefix}New result` };
    const props = { ...viewProps(), canvas: { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [before] } };
    props.onCanvasChanged.mockResolvedValue({ created: [], updated: [{ before, after }] });
    vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Updated QA."}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...props}/>);
    send('Update the QA result');
    fireEvent.click(await screen.findByText('Review changes to QA report'));
    expect(screen.getByText('Changed: content')).toBeTruthy();
    expect(screen.getByText(/Old result/)).toBeTruthy();
    expect(screen.getByText(/New result/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open updated document' }));
    expect(props.onShowBlock).toHaveBeenCalledWith(after, 'planning');
    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }));
    await waitFor(() => expect(props.onUndoEditedBlock).toHaveBeenCalledWith('planning', { before, after }));
    expect(await screen.findByText('Undid edit to QA report.')).toBeTruthy();
  });
  it('streams the answer live, folds a pre-tool note into activity, and shows Jev verification with a copy action', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AIElementsChat {...viewProps()}/>);
    send('What changed?');
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"Let me check the plan."}}]}\n\n'); });
    expect(screen.getByText('Let me check the plan.')).toBeTruthy();
    await act(async () => { stream.push('event: answer_reset\ndata: {}\n\n'); });
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"The plan moved to **May**."}}]}\n\n'); });
    expect(within(activityPanel()).getByText('Let me check the plan.')).toBeTruthy();
    await act(async () => { stream.push('event: verification\ndata: {"status":"checking"}\n\n'); });
    expect(screen.getByText('Checking sources')).toBeTruthy();
    await act(async () => { stream.push('event: verification\ndata: {"status":"unsupported","score":0.3}\n\ndata: [DONE]\n\n'); });
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain('may not be in the canvas docs'));
    expect(screen.getByText('May')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('The plan moved to **May**.'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('hides the verification badge when the answer has no canvas claims', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    render(<AIElementsChat {...viewProps()}/>);
    send('Say hello');
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\nevent: verification\ndata: {"status":"checking"}\n\n'); });
    expect(screen.getByText('Checking sources')).toBeTruthy();

    await act(async () => { stream.push('event: verification\ndata: {"status":"no_claims"}\n\ndata: [DONE]\n\n'); });
    await screen.findByRole('button', { name: 'Copy answer' });
    expect(screen.queryByText('Checking sources')).toBeNull();
    expect(screen.queryByText('Matches canvas docs')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('Hello!')).toBeTruthy();
  });

  it('shows an error event from the server with a retry', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('event: error\ndata: {"message":"Tool call limit reached"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    render(<AIElementsChat {...viewProps()}/>);
    send('Do everything');
    expect((await screen.findByRole('alert')).textContent).toContain('Tool call limit reached');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the question editable after a connection failure and retries without sending it twice', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Connected again."}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...viewProps()}/>);
    send('Which tests failed?');
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas server is unavailable');
    expect((screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }) as HTMLTextAreaElement).value).toBe('Which tests failed?');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Connected again.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows live thinking and tool calls, then folds completed steps above the answer', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    const props = viewProps();
    render(<AIElementsChat {...props}/>);
    send('Find the onboarding guide');
    expect(screen.getByText('Thinking…')).toBeTruthy();

    await act(async () => { stream.push('event: agent_step\ndata: {"type":"thinking","message":"Planning a search"}\n\n'); });
    expect(screen.getByText('Planning a search')).toBeTruthy();
    expect(activityButton().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"tool_start","id":"tool-1","name":"search_canvas","message":"Searching documents"}\n\n'); });
    expect(screen.getByText('Searching documents')).toBeTruthy();
    fireEvent.click(activityButton());
    expect(screen.getByText('search_canvas')).toBeTruthy();
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"tool_end","id":"tool-1","name":"search_canvas","message":"Search complete"}\n\n'); });
    expect(screen.queryByText('Searching documents')).toBeNull();
    expect(within(activityButton()).getByText('Search complete')).toBeTruthy();
    expect(screen.getByText('2 steps')).toBeTruthy();

    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"The guide is ready."}}]}\n\ndata: [DONE]\n\n'); });
    expect(await screen.findByText('The guide is ready.')).toBeTruthy();
    expect(activityButton().getAttribute('aria-expanded')).toBe('false');
    expect(within(activityButton()).getByText('Activity complete')).toBeTruthy();
    expect(props.onCanvasChanged).toHaveBeenCalledWith('planning', []);
  });

  it('collapses repeated LangChain snapshot events into one tool and one status', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Read the document');
    const snapshot =
      'event: agent_step\ndata: {"type":"tool_start","id":"call-42","name":"read_doc","message":"Running read_doc"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_end","id":"call-42","name":"read_doc","message":"Finished read_doc"}\n\n' +
      'event: agent_step\ndata: {"type":"thinking","message":"Reviewing the tool result"}\n\n';
    await act(async () => { stream.push(snapshot.repeat(18)); });
    expect(within(activityButton()).getByText('Reviewing the tool result')).toBeTruthy();
    expect(within(activityButton()).getByText('2 steps')).toBeTruthy();
    expect(activityButton().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(activityButton());
    expect(within(activityPanel()).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => { stream.push(snapshot.repeat(18)); });
    expect(within(activityPanel()).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n'); });
    await screen.findByText('Done.');
    expect(activityButton().getAttribute('aria-expanded')).toBe('false');
    expect(within(activityButton()).getByText('Activity complete')).toBeTruthy();
  });

  it('merges adjacent same-name tool events when their IDs are absent', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Read the document');
    const snapshot =
      'event: agent_step\ndata: {"type":"tool_start","name":"read_doc","message":"Running read_doc"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_end","name":"read_doc","message":"Finished read_doc"}\n\n' +
      'event: agent_step\ndata: {"type":"thinking","message":"Reviewing the tool result"}\n\n';
    await act(async () => { stream.push(snapshot.repeat(12)); });
    expect(within(activityButton()).getByText('2 steps')).toBeTruthy();
    fireEvent.click(activityButton());
    expect(within(activityPanel()).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => { stream.push('data: [DONE]\n\n'); });
  });

  it('keeps distinct unnamed tool calls separate when their names differ', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Check both docs');
    await act(async () => { stream.push(
      'event: agent_step\ndata: {"type":"tool_start","name":"read_doc","message":"Reading"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_start","name":"search_canvas","message":"Searching"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_end","name":"read_doc","message":"Read complete"}\n\n',
    ); });
    expect(within(activityButton()).getByText('3 steps')).toBeTruthy();
    fireEvent.click(activityButton());
    expect(within(activityPanel()).getAllByRole('listitem')).toHaveLength(3);
    await act(async () => { stream.push('data: [DONE]\n\n'); });
  });

  it('marks an unfinished tool as stopped when the answer stream ends', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Read the plan');
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"tool_start","id":"read","name":"read_block","message":"Reading a document"}\n\n'); });
    fireEvent.click(activityButton());
    expect(document.querySelector('.ai-chat__activity-step--active')).toBeTruthy();
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"Here is the plan."}}]}\n\ndata: [DONE]\n\n'); });
    await screen.findByText('Here is the plan.');
    fireEvent.click(activityButton());
    expect(document.querySelector('.ai-chat__activity-step--stopped')).toBeTruthy();
  });

  it('keeps incomplete and unmatched tool events visible without claiming they completed', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Check the docs');
    await act(async () => { stream.push(
      'event: agent_step\ndata: {"type":"tool_end","message":"A previous check finished"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_start","id":"read","name":"read_block","message":"Reading a document"}\n\n' +
      'event: agent_step\ndata: {"type":"thinking","message":"Preparing the answer"}\n\n' +
      'event: agent_step\ndata: {"type":"tool_end","id":"unknown","name":"search_canvas","message":"Another check finished"}\n\n',
    ); });
    expect(screen.getByText('4 steps')).toBeTruthy();
    await act(async () => { stream.push('data: [DONE]\n\n'); });
    await waitFor(() => expect(within(activityButton()).getByText('Activity stopped')).toBeTruthy());
    fireEvent.click(activityButton());
    expect(document.querySelectorAll('.ai-chat__activity-step--stopped')).toHaveLength(1);
    expect(document.querySelectorAll('.ai-chat__activity-step--complete')).toHaveLength(3);
  });

  it('completes a thinking status when the stream finishes without another step', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    render(<AIElementsChat {...viewProps()}/>);
    send('Summarize the plan');
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"thinking","message":"Preparing the summary"}\n\n'); });
    fireEvent.click(activityButton());
    expect(document.querySelector('.ai-chat__activity-step--active')).toBeTruthy();
    await act(async () => { stream.push('data: [DONE]\n\n'); });
    await waitFor(() => expect(within(activityButton()).getByText('Activity complete')).toBeTruthy());
    fireEvent.click(activityButton());
    expect(document.querySelector('.ai-chat__activity-step--complete')).toBeTruthy();
  });

  it('keeps the same user turn when retrying after a failed stream', async () => {
    const answer = 'data: {"choices":[{"delta":{"content":"Found it."}}]}\n\ndata: [DONE]\n\n';
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'OpenRouter unavailable' }, { status: 502 })).mockResolvedValueOnce(new Response(answer));
    render(<AIElementsChat {...viewProps()}/>);
    send('Find the guide');
    expect((await screen.findByRole('alert')).textContent).toContain('OpenRouter unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Found it.')).toBeTruthy();
    expect(screen.getAllByText('Find the guide')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = vi.mocked(fetch).mock.calls[0][1]?.body;
    const second = vi.mocked(fetch).mock.calls[1][1]?.body;
    expect(second).toBe(first);
  });

  it('marks in-progress steps stopped when the user stops the request', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => stream.fail(new Error('Stopped')));
      return new Response(stream.body);
    });
    const props = viewProps();
    render(<AIElementsChat {...props}/>);
    send('Search docs');
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"tool_start","id":"search","name":"search_canvas","message":"Searching docs"}\n\n'); });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy());
    await waitFor(() => expect(within(activityButton()).getByText('Activity stopped')).toBeTruthy());
    fireEvent.click(activityButton());
    expect(activityButton().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.ai-chat__activity-step--stopped')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(props.onCanvasChanged).not.toHaveBeenCalled();
  });

  it('avoids duplicate sends and opens settings when no chat key is available', async () => {
    const stream = controlledStream();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body));
    const props = viewProps();
    const { rerender } = render(<AIElementsChat {...props}/>);
    send('First request');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }), { target: { value: 'Second request' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Message the SymbiKnow assistant' }).closest('form')!);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { stream.push('data: [DONE]\n\n'); });
    rerender(<AIElementsChat {...props} hasApiKey={false}/>);
    expect(screen.getByText('Connect a chat model in Settings to talk with this canvas.')).toBeTruthy();
    send('Need help');
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('explains when no canvas is open and handles an unknown stream failure', async () => {
    const props = viewProps();
    const { rerender } = render(<AIElementsChat {...props} canvasId=""/>);
    send('Hello');
    expect((await screen.findByRole('alert')).textContent).toContain('Open a canvas before using the assistant.');
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error('connection lost'); } })));
    rerender(<AIElementsChat {...props}/>);
    send('Hello');
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Please try again.');
  });
});
