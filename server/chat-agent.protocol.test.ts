import { describe, expect, it } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ApiError } from './storage.js';
import { agentProgress, collectSnapshot, finalAnswer, textPieces, type AgentRun, type ChatStreamEvent } from './chat-agent.js';

async function failed(error: unknown) {
  const run: AgentRun = async function* () { throw error; };
  return collectSnapshot(run, [], new AbortController().signal, 'Protocol provider');
}
async function progress(run: AgentRun) {
  const events: ChatStreamEvent[] = [];
  const iterator = agentProgress(run, [], new AbortController().signal, 'Protocol provider', { seen: 0, started: false, streamed: '' });
  let result = await iterator.next();
  while (!result.done) { events.push(result.value); result = await iterator.next(); }
  return { events, snapshot: result.value };
}

describe('Chat agent public stream compatibility', () => {
  it('retains typed client errors and safely classifies alternate provider error representations', async () => {
    const client = new ApiError(409, 'Document changed');
    await expect(failed(client)).rejects.toBe(client);
    const canceled = new ApiError(499, 'Request canceled');
    await expect(failed(canceled)).rejects.toBe(canceled);
    const cases: [unknown, string][] = [
      [{ status: 418 }, 'Protocol provider request failed (418). Check the provider status and retry.'],
      [{ statusCode: 404 }, 'Protocol provider request failed (404). The selected model was not found. Choose another model in Settings.'],
      [{ message: 'Error code: 403 hidden-key' }, 'Protocol provider request failed (403). This key cannot use the selected model. Check provider access and Settings.'],
      [{ cause: { cause: { status: 402 } } }, 'Protocol provider request failed (402). The account has insufficient credits. Check billing with the provider.'],
      [{ status: 400 }, 'Protocol provider request failed (400). The model rejected this request.'],
      [new ApiError(500, 'Hidden'), 'Protocol provider request failed (500). The provider had an internal error. Retry shortly.'],
      [new ApiError(399, 'Hidden'), 'Protocol provider request failed. Check the model and API key in Settings.'],
      [null, 'Protocol provider request failed. Check the model and API key in Settings.'],
      ['Hidden network detail', 'Protocol provider request failed. Check the model and API key in Settings.'],
      [{ cause: { cause: { cause: { status: 401 } } } }, 'Protocol provider request failed. Check the model and API key in Settings.'],
      [{ status: 900, message: 3 }, 'Protocol provider request failed. Check the model and API key in Settings.'],
    ];
    for (const [error, message] of cases) await expect(failed(error)).rejects.toMatchObject({ status: 502, message });
  });

  it('ignores unrelated stream modes, malformed token envelopes, nested tokens and tool-note chunks', async () => {
    const run: AgentRun = async function* () {
      yield ['custom', { private: 'internal' }];
      yield ['messages', null];
      yield ['messages', [new HumanMessage('Hidden human text'), { langgraph_node: 'model_request' }]];
      yield ['messages', [new AIMessageChunk('Hidden tool-node text'), { langgraph_node: 'tools' }]];
      yield ['messages', [new AIMessageChunk('Hidden nested text'), { langgraph_node: 'model_request', langgraph_checkpoint_ns: 'tools:1|model_request:2' }]];
      yield ['messages', [new AIMessageChunk({ content: 'Hidden tool note', tool_call_chunks: [{ id: 'tool', name: 'lookup', args: '{}', index: 0 }] }), { langgraph_node: 'model_request' }]];
      yield ['messages', [new AIMessageChunk('Visible answer'), { langgraph_node: 'model_request' }]];
      yield ['values', { messages: [new AIMessage('Visible answer')] }];
    };
    expect((await progress(run)).events).toEqual([
      { kind: 'step', step: { type: 'thinking', message: 'Working on your request' } },
      { kind: 'text', content: 'Visible answer' },
    ]);
    expect(finalAnswer(await collectSnapshot(run, [], new AbortController().signal, 'Protocol provider'), 'Protocol provider')).toBe('Visible answer');
  });

  it('resets streamed planning text when a completed snapshot announces its tool call', async () => {
    const call = new AIMessage({ content: 'Planning', tool_calls: [{ id: 'lookup', name: 'lookup_document', args: {} }] });
    const run: AgentRun = async function* () {
      yield ['messages', [new AIMessageChunk('Planning'), { langgraph_node: 'model_request' }]];
      yield { messages: [call] };
      yield { messages: [call, new ToolMessage({ content: 'Private source', tool_call_id: 'lookup', name: 'lookup_document' })] };
      yield { messages: [call, new ToolMessage({ content: 'Private source', tool_call_id: 'lookup', name: 'lookup_document' }), new AIMessage('Final answer')] };
    };
    const result = await progress(run);
    expect(result.events.map(event => event.kind)).toEqual(['step', 'text', 'reset', 'step', 'step', 'step']);
    expect(result.events[2]).toEqual({ kind: 'reset' });
    expect(finalAnswer(result.snapshot, 'Protocol provider')).toBe('Final answer');
    expect(JSON.stringify(result.events)).not.toContain('Private source');
  });

  it('refuses missing, unfinished or textless final output and preserves ordered text pieces', () => {
    const missing: Array<{ messages?: BaseMessage[] } | undefined> = [undefined, {}, { messages: [] },
      { messages: [new HumanMessage('User')] }, { messages: [new AIMessage({ content: 'Planning', tool_calls: [{ id: 'call', name: 'lookup', args: {} }] })] }];
    for (const snapshot of missing) expect(() => finalAnswer(snapshot, 'Protocol provider')).toThrow('Protocol provider returned no final answer');
    expect(() => finalAnswer({ messages: [new AIMessage('')] }, 'Protocol provider')).toThrow('Protocol provider returned no text');
    const answer = 'α'.repeat(257);
    expect([...textPieces(answer)]).toEqual(['α'.repeat(256), 'α']);
    expect([...textPieces('')]).toEqual([]);
  });
});
