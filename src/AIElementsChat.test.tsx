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
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
}

function retryOracle(first: () => Response | Promise<Response>, second: () => Response) {
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/canvases/planning' && !init?.method) return Response.json({ id: 'planning', blocks: [] });
    if (String(input) === '/api/chat/stream' && init?.method === 'POST') return attempts++ === 0 ? first() : second();
    throw new Error('Unexpected retry request ' + String(input));
  });
}
function chatRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === '/api/chat/stream' && init?.method === 'POST');
}
function expectRetryBaseline() {
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/canvases/planning')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith('/api/canvases/planning', expect.objectContaining({ cache: 'no-store' }));
}

function activityPanel() {
  return screen.getByRole('region', { name: 'Agent activity' });
}

function activityButton() {
  return within(activityPanel()).getByRole('button');
}

beforeEach(() => {
  window.sessionStorage.removeItem('symbiknow:chat-draft');
  window.localStorage.removeItem('symbiknow:chat-history');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AI Elements agent activity', () => {
  it('restores a completed conversation after remounting', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Saved answer."}}]}\n\ndata: [DONE]\n\n'));
    const first = render(<AIElementsChat {...viewProps()}/>);
    send('Keep this question');
    expect(await screen.findByText('Saved answer.')).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem('symbiknow:chat-history')).toContain('Saved answer.'));
    first.unmount();
    render(<AIElementsChat {...viewProps()}/>);
    expect(screen.getByText('Keep this question')).toBeTruthy();
    expect(screen.getByText('Saved answer.')).toBeTruthy();
  });
  it('opens a named investigation with its messages and source navigation', async () => {
    const canvas = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [] };
    const researchSnapshot = { turns: [{ id: 9, query: 'What changed?', answer: 'QA shifted.', sources: [], status: 'complete' as const }],
      edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'roadmap' as const };
    const saved = { id: 'saved-1', workspaceId: 'team', canvasId: 'planning', title: 'Launch review', visibility: 'shared',
      messages: [{ role: 'user', content: 'What changed?' }, { role: 'assistant', content: 'The QA plan changed.' }],
      sourceRefs: [{ canvasId: 'planning', blockId: 'qa', excerpt: 'QA approval moved to Friday.' }], proposalRefs: [],
      researchSnapshot,
      revision: 1, createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z' };
    const onNavigate = vi.fn();
    const onRestoreResearch = vi.fn();
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input) === '/api/investigations/list') return Response.json({ investigations: [{ ...saved,
        messageCount: 2, sourceCount: 1, proposalCount: 0 }] });
      if (String(input) === '/api/investigations/saved-1') return Response.json(saved);
      throw new Error('Unexpected request ' + String(input));
    });
    render(<AIElementsChat {...viewProps()} canvas={canvas} onNavigate={onNavigate} onRestoreResearch={onRestoreResearch}/>);
    fireEvent.click(screen.getByText('Saved investigations'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('The QA plan changed.')).toBeTruthy();
    expect(onRestoreResearch).toHaveBeenCalledWith(researchSnapshot);
    fireEvent.click(screen.getByRole('button', { name: 'Open planning / qa' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'document', canvasId: 'planning', blockId: 'qa',
      title: 'qa', excerpt: 'QA approval moved to Friday.', contentHash: undefined });
  });
  it('isolates restored investigation research from late events and keeps the next run stoppable', async () => {
    const previousStream = controlledStream();
    const nextStream = controlledStream();
    const snapshot = { turns: [{ id: 9, query: 'Saved research', answer: 'Saved answer', sources: [], status: 'complete' }],
      edits: { added: [], changed: {}, deleted: [], addedEdges: [], deletedEdges: [] }, layout: 'mindmap' };
    const record = { id: 'saved-1', workspaceId: 'team', canvasId: 'planning', title: 'Saved review', visibility: 'shared',
      messages: [{ role: 'user', content: 'Saved question' }, { role: 'assistant', content: 'Saved answer' }],
      sourceRefs: [], proposalRefs: [], researchSnapshot: snapshot,
      revision: 1, createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z' };
    const persisted = 'symbiknow:test-investigation-research';
    const props = viewProps();
    const signals: AbortSignal[] = [];
    let requests = 0;
    props.onCanvasPatch.mockImplementation(async (_id, patch) => {
      const research = JSON.parse(window.localStorage.getItem(persisted)!);
      research.turns.push({ query: patch.query });
      window.localStorage.setItem(persisted, JSON.stringify(research));
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/chat/stream') {
        signals.push(init!.signal as AbortSignal);
        return new Response(++requests === 1 ? previousStream.body : nextStream.body);
      }
      if (String(input) === '/api/investigations/list') return Response.json({ investigations: [{ ...record,
        messageCount: 2, sourceCount: 0, proposalCount: 0 }] });
      if (String(input) === '/api/investigations/saved-1') return Response.json(record);
      throw new Error('Unexpected request ' + String(input));
    });
    render(<AIElementsChat {...props} canvas={{ id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [] }}
      onRestoreResearch={value => window.localStorage.setItem(persisted, JSON.stringify(value))}/>);
    send('Live question');
    await act(async () => previousStream.push('data: {"choices":[{"delta":{"content":"Working on the live answer"}}]}\n\n'));
    fireEvent.click(screen.getByText('Saved investigations'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Saved answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    props.onCanvasAnswer.mockClear();
    send('Follow up on the saved investigation');
    await screen.findByRole('button', { name: 'Stop' });
    const patch = { query: 'Unrelated live research', blocks: [{ id: 'late', type: 'text', title: 'Late block',
      content: 'Old stream content', sourceIds: [] }], edges: [] };
    await act(async () => previousStream.push([
      `event: research_canvas_patch\ndata: ${JSON.stringify(patch)}`,
      'event: answer_canvas\ndata: {"query":"Old question","canvasId":"planning","selection":"local","sources":[]}',
      'event: canvas_navigation\ndata: {"kind":"document","canvasId":"planning","blockId":"old","title":"Old source"}',
      'event: research_verification\ndata: {"status":"unverified","patchIndex":0,"blocks":[]}',
      'data: {"choices":[{"delta":{"content":"Late old answer"}}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'));
    expect(JSON.parse(window.localStorage.getItem(persisted)!)).toEqual(snapshot);
    expect(signals[0].aborted).toBe(true);
    expect(props.onCanvasPatch).not.toHaveBeenCalled();
    expect(props.onCanvasSources).not.toHaveBeenCalled();
    expect(props.onCanvasAnswer).not.toHaveBeenCalled();
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(props.onCanvasChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(signals[1].aborted).toBe(true);
    await act(async () => nextStream.fail(new Error('Stopped')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy());
    expect(screen.queryByText('Late old answer')).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem('symbiknow:chat-history')).toContain('Saved answer'));
    expect(window.localStorage.getItem('symbiknow:chat-history')).not.toContain('Late old answer');
    window.localStorage.removeItem(persisted);
  });
  it('ignores a held chat response that resolves after an investigation replaces the conversation', async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const record = { id: 'saved-2', workspaceId: 'team', canvasId: 'planning', title: 'Saved review', visibility: 'shared',
      messages: [{ role: 'assistant', content: 'Recovered answer' }], sourceRefs: [], proposalRefs: [],
      revision: 1, createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z' };
    let signal!: AbortSignal;
    const props = viewProps();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/chat/stream') { signal = init!.signal as AbortSignal; return response; }
      if (String(input) === '/api/investigations/list') return Response.json({ investigations: [{ ...record,
        messageCount: 1, sourceCount: 0, proposalCount: 0 }] });
      if (String(input) === '/api/investigations/saved-2') return Response.json(record);
      throw new Error('Unexpected request ' + String(input));
    });
    render(<AIElementsChat {...props} canvas={{ id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [] }}/>);
    send('Pending question');
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByText('Saved investigations'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Recovered answer')).toBeTruthy();
    await act(async () => resolveResponse(new Response('data: {"choices":[{"delta":{"content":"Old response"}}]}\n\ndata: [DONE]\n\n')));
    expect(signal.aborted).toBe(true);
    expect(props.onCanvasAnswer).not.toHaveBeenCalled();
    expect(props.onCanvasTurnEnd).not.toHaveBeenCalled();
    expect(props.onCanvasChanged).not.toHaveBeenCalled();
    expect(screen.queryByText('Old response')).toBeNull();
  });
  it('reopens a saved pending proposal for before-and-after review', async () => {
    const before: CanvasBlock = { id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: '# Before\nold detail',
      x: 10, y: 20, width: 300, height: 200, links: [], contentHash: 'old-hash' };
    const after = { ...before, content: '# After\nnew detail', contentHash: 'new-hash' };
    const saved = { id: 'saved-1', workspaceId: 'team', canvasId: 'planning', title: 'Launch review', visibility: 'shared',
      messages: [{ role: 'user', content: 'Update QA' }], sourceRefs: [], proposalRefs: [{ kind: 'chat', id: 'proposal-1', status: 'pending' }],
      revision: 1, createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z' };
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input) === '/api/investigations/list') return Response.json({ investigations: [{ ...saved,
        messageCount: 1, sourceCount: 0, proposalCount: 1 }] });
      if (String(input) === '/api/investigations/saved-1') return Response.json(saved);
      if (String(input) === '/api/chat/proposals/proposal-1') return Response.json({ id: 'proposal-1', canvasId: 'planning', status: 'pending',
        changes: [{ id: 'qa', type: 'edit', blockId: 'qa', title: 'QA report', before, after, expectedContentHash: 'old-hash', canApply: true }] });
      throw new Error('Unexpected request ' + String(input));
    });
    render(<AIElementsChat {...viewProps()} canvas={{ id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [before] }}/>);
    fireEvent.click(screen.getByText('Saved investigations'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review proposal in Chat' }));
    const review = await screen.findByRole('region', { name: 'Review proposed document changes' });
    fireEvent.click(within(review).getByText('Inspect full before and after'));
    expect(within(review).getByText(/old detail/)).toBeTruthy();
    expect(within(review).getByText(/new detail/)).toBeTruthy();
    expect(within(review).getByRole('button', { name: 'Apply selected (1)' })).toBeTruthy();
  });
  it('reviews a full staged document change before Apply and exposes Undo after the receipt', async () => {
    const before: CanvasBlock = { id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: '# Before\nold detail',
      x: 10, y: 20, width: 300, height: 200, links: [], contentHash: 'old-hash' };
    const after = { ...before, content: '# After\nnew detail', contentHash: 'new-hash' };
    const proposal = { id: 'proposal-1', canvasId: 'planning', status: 'pending', changes: [{ id: 'change-1', type: 'edit',
      blockId: 'qa', title: 'QA report', before, after, expectedContentHash: 'old-hash' }] };
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input) === '/api/chat/stream') return new Response(`data: {"choices":[{"delta":{"content":"I prepared a QA update."}}]}\n\nevent: chat_proposal\ndata: ${JSON.stringify(proposal)}\n\ndata: [DONE]\n\n`);
      if (String(input) === '/api/canvases/planning') return Response.json({ id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [before] });
      if (String(input).endsWith('/apply')) return Response.json({ id: 'proposal-1', status: 'applied', applied: ['change-1'], skipped: [],
        createdBlockIds: {}, documents: [{ before, after }] });
      if (String(input).endsWith('/undo')) return Response.json({ id: 'proposal-1', status: 'reverted', reverted: ['change-1'] });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    render(<AIElementsChat {...viewProps()}/>);
    send('Update the QA report');
    const review = await screen.findByRole('region', { name: 'Review proposed document changes' });
    expect(calls).not.toContain('/api/chat/proposals/proposal-1/apply');
    fireEvent.click(within(review).getByText('Inspect full before and after'));
    expect(within(review).getByText(/old detail/)).toBeTruthy();
    expect(within(review).getByText(/new detail/)).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: 'Apply selected (1)' }));
    expect(await within(review).findByRole('button', { name: 'Undo applied changes' })).toBeTruthy();
    expect(calls).toContain('/api/chat/proposals/proposal-1/apply');
    fireEvent.click(within(review).getByRole('button', { name: 'Undo applied changes' }));
    expect(await within(review).findByText(/The applied changes were reverted/)).toBeTruthy();
  });
  it('moves Symbi through finding sources, answering, and a brief completed state', async () => {
    const stream = controlledStream();
    const onAvatarStateChange = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    render(<AIElementsChat {...viewProps()} onAvatarStateChange={onAvatarStateChange}/>);
    expect(onAvatarStateChange).toHaveBeenLastCalledWith('idle');

    send('What changed?');
    await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('listening'));
    await act(async () => { stream.push('event: agent_step\ndata: {"type":"thinking","message":"Evaluating sources"}\n\n'); });
    await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('thinking'));
    await act(async () => { stream.push('data: {"choices":[{"delta":{"content":"The owner changed."}}]}\n\n'); });
    await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('speaking'));
    await act(async () => { stream.push('data: [DONE]\n\n'); });
    await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('done'));
  });

  it('changes Symbi motion with the active search, reading, canvas, navigation, and other tools', async () => {
    const stream = controlledStream();
    const onAvatarStateChange = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } }));
    render(<AIElementsChat {...viewProps()} onAvatarStateChange={onAvatarStateChange}/>);
    send('Find, read, map, and open the plan');
    const steps = [
      ['search_docs', 'searching', 'Searching documents…'],
      ['read_doc', 'reading', 'Reading the source…'],
      ['draw_research_canvas', 'organizing', 'Organizing the research canvas…'],
      ['show_doc_on_canvas', 'moving', 'Opening the right place…'],
      ['external_tool', 'tooling', 'Working with a tool…'],
    ] as const;
    for (const [name, state, label] of steps) {
      await act(async () => { stream.push(`event: agent_step\ndata: ${JSON.stringify({ type: 'tool_start', id: name, name, message: `Running ${name}` })}\n\n`); });
      await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith(state));
      expect(screen.getByText(label)).toBeTruthy();
      await act(async () => { stream.push(`event: agent_step\ndata: ${JSON.stringify({ type: 'tool_end', id: name, name, message: `Finished ${name}` })}\n\n`); });
      await waitFor(() => expect(onAvatarStateChange).toHaveBeenLastCalledWith('thinking'));
    }
    await act(async () => { stream.push('data: [DONE]\n\n'); });
  });

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
  it('streams the answer live, folds a pre-tool note into activity, and retains a copy action', async () => {
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
    expect(screen.queryByText('Checking sources')).toBeNull();
    await act(async () => { stream.push('event: verification\ndata: {"status":"unsupported","score":0.3}\n\ndata: [DONE]\n\n'); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(screen.queryByText('Source check needs review')).toBeNull();
    expect(screen.getByText('May')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('The plan moved to **May**.'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('shows an error event from the server with a retry', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('event: error\ndata: {"message":"Tool call limit reached"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    render(<AIElementsChat {...viewProps()}/>);
    send('Do everything');
    expect((await screen.findByRole('alert')).textContent).toContain('Tool call limit reached');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the question editable after a connection failure and retries without sending it twice', async () => {
    retryOracle(() => Promise.reject(new Error('offline')),
      () => new Response('data: {"choices":[{"delta":{"content":"Connected again."}}]}\n\ndata: [DONE]\n\n'));
    render(<AIElementsChat {...viewProps()}/>);
    send('Which tests failed?');
    expect((await screen.findByRole('alert')).textContent).toContain('Canvas server is unavailable');
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('Which tests failed?');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chatRequests()).toHaveLength(2));
    expectRetryBaseline();
    expect(chatRequests()[1][1]?.body).toBe(chatRequests()[0][1]?.body);
    expect(screen.getAllByText('Which tests failed?')).toHaveLength(1);
    expect(await screen.findByText('Connected again.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('');
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
    retryOracle(() => Response.json({ error: 'OpenRouter unavailable' }, { status: 502 }), () => new Response(answer));
    render(<AIElementsChat {...viewProps()}/>);
    send('Find the guide');
    expect((await screen.findByRole('alert')).textContent).toContain('OpenRouter unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Found it.')).toBeTruthy();
    expect(screen.getAllByText('Find the guide')).toHaveLength(1);
    expect(chatRequests()).toHaveLength(2);
    expectRetryBaseline();
    const first = chatRequests()[0][1]?.body;
    const second = chatRequests()[1][1]?.body;
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Second request' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Message Symbi' }).closest('form')!);
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
