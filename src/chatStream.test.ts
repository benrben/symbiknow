import { describe, expect, it, vi } from 'vitest';
import { streamCanvasChat } from './chatStream';

function chunks(...text: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of text) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('canvas chat SSE transport', () => {
  it('sends OpenAI conversation turns and reads content split across network chunks', async () => {
    const body = chunks(
      'data: {"choices":[{"delta":{"content":"Road',
      'map "}}]}\r',
      '\n\r\ndata: {"choices":[{"delta":{"content":"updated"}}]}\n\n',
      'data: [DONE]\n\n',
    );
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const onChunk = vi.fn();
    const controller = new AbortController();
    const messages = [{ role: 'user' as const, content: 'Update roadmap' }];

    await streamCanvasChat({ canvasId: 'planning', messages, signal: controller.signal, onChunk, fetcher });

    expect(onChunk.mock.calls.map(call => call[0])).toEqual(['Roadmap ', 'updated']);
    expect(fetcher).toHaveBeenCalledWith('/api/chat/stream', expect.objectContaining({
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ canvasId: 'planning', messages }),
    }));
  });

  it('sends the current view and opens a temporary source canvas from a typed event', async () => {
    const onAnswerCanvas = vi.fn();
    const viewContext = { selectedBlockIds: ['qa'], readerBlockId: 'qa', viewMode: 'documents' as const };
    const canvas = { canvasId: 'planning', query: 'What blocks launch?', selection: 'jev', sources: [
      { canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Tests failed', relevance: .9 },
    ] };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      void _input;
      void init;
      return new Response(chunks(`event: answer_canvas\ndata: ${JSON.stringify(canvas)}\n\n`, 'data: [DONE]\n\n'));
    });
    await streamCanvasChat({ canvasId: 'planning', messages: [{ role: 'user', content: canvas.query }], viewContext,
      signal: new AbortController().signal, onChunk: vi.fn(), onAnswerCanvas, fetcher });
    expect(onAnswerCanvas).toHaveBeenCalledWith(canvas);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ viewContext });
  });

  it('delivers native canvas navigation as a typed event', async () => {
    const onNavigation = vi.fn();
    const target = { kind: 'document', canvasId: 'planning', blockId: 'qa', title: 'QA report' };
    await streamCanvasChat({ canvasId: 'planning', messages: [{ role: 'user', content: 'Open QA report' }],
      signal: new AbortController().signal, onChunk: vi.fn(), onNavigation,
      fetcher: async () => new Response(chunks(`event: canvas_navigation\ndata: ${JSON.stringify(target)}\n\n`, 'data: [DONE]\n\n')) });
    expect(onNavigation).toHaveBeenCalledWith(target);
  });

  it('delivers multiple research blocks and edges as one typed canvas patch', async () => {
    const onResearchPatch = vi.fn();
    const patch = { query: 'Map launch', layout: 'architecture', blocks: [
      { id: 'summary', type: 'text', title: 'Summary', content: 'Launch risk', sourceIds: [] },
      { id: 'flow', type: 'diagram', title: 'Flow', content: '```mermaid\nflowchart LR\nA-->B\n```', sourceIds: [] },
    ], edges: [{ from: 'summary', to: 'flow', label: 'explains' }] };
    await streamCanvasChat({ canvasId: 'planning', messages: [{ role: 'user', content: patch.query }],
      signal: new AbortController().signal, onChunk: vi.fn(), onResearchPatch,
      fetcher: async () => new Response(chunks(`event: research_canvas_patch\ndata: ${JSON.stringify(patch)}\n\n`, 'data: [DONE]\n\n')) });
    expect(onResearchPatch).toHaveBeenCalledWith(patch);
  });

  it('delivers an explicit choice of research, current view, or navigation', async () => {
    const onPresentationChoice = vi.fn();
    const choice = { question: 'Help me with this?', options: [
      { label: 'Build a research canvas', detail: 'Map evidence', prompt: 'Create a temporary research canvas for: Help me with this?' },
      { label: 'Work on this view', detail: 'Use current view', prompt: 'Answer in chat using the current view: Help me with this?' },
    ] };
    await streamCanvasChat({ canvasId: 'planning', messages: [{ role: 'user', content: choice.question }],
      signal: new AbortController().signal, onChunk: vi.fn(), onPresentationChoice,
      fetcher: async () => new Response(chunks(`event: presentation_choice\ndata: ${JSON.stringify(choice)}\n\n`, 'data: [DONE]\n\n')) });
    expect(onPresentationChoice).toHaveBeenCalledWith(choice);
  });

  it('marks merge drafting requests as previews without changing ordinary chat requests', async () => {
    const bodies: unknown[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('/api/chat/stream');
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(chunks('data: [DONE]\n\n'));
    };
    await streamCanvasChat({ canvasId: 'planning', messages: [{ role: 'user', content: 'Draft merge' }], previewMerge: true, intentToken: 'one-time-token',
      signal: new AbortController().signal, onChunk: vi.fn(), fetcher });
    expect(bodies).toEqual([{ canvasId: 'planning', messages: [{ role: 'user', content: 'Draft merge' }], previewMerge: true, intentToken: 'one-time-token' }]);
  });

  it('surfaces server and interrupted stream failures', async () => {
    const request = { canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk: vi.fn() };
    await expect(streamCanvasChat({ ...request, fetcher: async () => Response.json({ error: 'OpenRouter unavailable' }, { status: 502 }) }))
      .rejects.toThrow('OpenRouter unavailable');
    await expect(streamCanvasChat({ ...request, fetcher: async () => new Response(chunks('data: {"choices":[]}\n\n')) }))
      .rejects.toThrow('connection closed before the reply completed');
    await expect(streamCanvasChat({ ...request, fetcher: async () => new Response(null) }))
      .rejects.toThrow('empty stream');
    await expect(streamCanvasChat({ ...request, fetcher: async () => new Response('upstream unavailable', { status: 503 }) }))
      .rejects.toThrow('Canvas chat request failed (503)');
    await expect(streamCanvasChat({ ...request, fetcher: async () => new Response(chunks('data: {"error":"Stream failed"}\n\n')) }))
      .rejects.toThrow('Stream failed');
  });

  it('ignores SSE keepalives and metadata-only deltas', async () => {
    const onChunk = vi.fn();
    await streamCanvasChat({
      canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk,
      fetcher: async () => new Response(chunks(': keepalive\n\ndata: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n')),
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('delivers safe agent activity beside the answer stream', async () => {
    const onChunk = vi.fn();
    const onStep = vi.fn();
    const body = chunks(
      'event: agent_step\ndata: {"type":"thinking","message":"Planning the next step","hidden":"internal"}\n\n',
      'event: agent_step\ndata: {"type":"tool_start","id":"call-1","name":"search_canvas","message":"Searching canvas docs","input":{"secret":"never forward"}}\n\n',
      'event: agent_step\ndata: {"type":"tool_end","id":"call-1","name":"search_canvas","message":"Search complete","output":"never forward"}\n\n',
      'data: {"choices":[{"delta":{"content":"Found the guide."}}]}\n\ndata: [DONE]\n\n',
    );
    await streamCanvasChat({ canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk, onStep, fetcher: async () => new Response(body) });
    expect(onStep.mock.calls.map(call => call[0])).toEqual([
      { type: 'thinking', id: undefined, name: undefined, message: 'Planning the next step' },
      { type: 'tool_start', id: 'call-1', name: 'search_canvas', message: 'Searching canvas docs' },
      { type: 'tool_end', id: 'call-1', name: 'search_canvas', message: 'Search complete' },
    ]);
    expect(onChunk).toHaveBeenCalledWith('Found the guide.');
  });

  it('ignores malformed activity events and still reads the answer', async () => {
    const onChunk = vi.fn();
    const onStep = vi.fn();
    await streamCanvasChat({ canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk, onStep,
      fetcher: async () => new Response(chunks(
        'event: agent_step\ndata: null\n\n',
        'event: agent_step\ndata: {"type":"other","message":"not a step"}\n\n',
        'event: agent_step\ndata: {"type":"tool_start","message":42}\n\n',
        'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n',
      )),
    });
    expect(onStep).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledWith('Done');
  });

  it('reports answer resets and Jev verification, and throws on an error event', async () => {
    const onChunk = vi.fn();
    const onReset = vi.fn();
    const onVerification = vi.fn();
    await streamCanvasChat({ canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk, onReset, onVerification,
      fetcher: async () => new Response(chunks(
        'data: {"choices":[{"delta":{"content":"Let me check."}}]}\n\n',
        'event: answer_reset\ndata: {}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n',
        'event: verification\ndata: {"status":"checking"}\n\n',
        'event: verification\ndata: {"status":"unsupported","score":0.2}\n\n',
        'event: verification\ndata: {"status":"no_claims"}\n\n',
        'event: verification\ndata: {"status":"bogus"}\n\n',
        'data: [DONE]\n\n',
      )) });
    expect(onChunk.mock.calls.map(call => call[0])).toEqual(['Let me check.', 'Answer.']);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onVerification.mock.calls.map(call => call[0])).toEqual([{ status: 'checking' }, { status: 'unsupported', score: 0.2 }, { status: 'no_claims' }]);
    await expect(streamCanvasChat({ canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk: vi.fn(),
      fetcher: async () => new Response(chunks('event: error\ndata: {"message":"Tool call limit reached"}\n\n')) })).rejects.toThrow('Tool call limit reached');
  });

  it('keeps a completed reply when the stream refuses cancellation', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
      cancel() { throw new Error('cancel failed'); },
    });
    await expect(streamCanvasChat({
      canvasId: 'planning', messages: [], signal: new AbortController().signal, onChunk: vi.fn(),
      fetcher: async () => new Response(body),
    })).resolves.toBeUndefined();
  });

  it('turns network failures into a useful message and propagates cancellation', async () => {
    const controller = new AbortController();
    const request = { canvasId: 'planning', messages: [], signal: controller.signal, onChunk: vi.fn() };
    await expect(streamCanvasChat({ ...request, fetcher: async () => { throw new Error('ECONNREFUSED'); } }))
      .rejects.toThrow('Canvas server is unavailable');
    const pending = new AbortController();
    pending.abort(new Error('cancelled'));
    await expect(streamCanvasChat({ ...request, signal: pending.signal, fetcher: async () => new Response(chunks('data: [DONE]\n\n')) }))
      .rejects.toThrow('cancelled');
    await expect(streamCanvasChat({ ...request, signal: pending.signal, fetcher: async () => { throw new Error('cancelled during fetch'); } }))
      .rejects.toThrow('cancelled during fetch');
  });
});
