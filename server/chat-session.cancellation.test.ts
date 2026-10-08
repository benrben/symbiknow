import { describe, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { answer, begin, chunk, events, fixture, nextRequest, tokens } from './chat-session.test.fixture.js';

describe('native chat session cancellation and recovery', () => {
  it.each(['tokens', 'events'] as const)('closes an already stopped %s session without contacting either provider', async surface => {
    const setup = await fixture();
    const prepared = await setup.sessionContext();
    const stop = new AbortController();
    stop.abort(new Error('Stopped before iteration'));
    const result = surface === 'tokens' ? await tokens(prepared.session, stop.signal) : await events(prepared.session, stop.signal);
    expect(result).toEqual([]);
    expect(setup.model.requests).toEqual([]);
    expect(prepared.context.toolContext.signal?.aborted).toBe(true);
    expect(prepared.cleanup.closed).toBe(1);
    await expect(prepared.cleanup.file.write('closed')).rejects.toMatchObject({ code: 'EBADF' });
  });

  it.each(['preparation', 'request'] as const)('stops real in-flight model events through the %s signal and starts a fresh session', async target => {
    const setup = await fixture();
    setup.model.handle = (_request, response) => { begin(response); chunk(response, { role: 'assistant', content: 'Partial evidence.' }); };
    const preparation = new AbortController();
    const request = new AbortController();
    const prepared = await setup.sessionContext({ preparationSignal: preparation.signal });
    const stream = prepared.session.events!(request.signal);
    expect(await stream.next()).toMatchObject({ value: { kind: 'step' }, done: false });
    expect(await stream.next()).toEqual({ value: { kind: 'text', content: 'Partial evidence.' }, done: false });
    const stopped = stream.next();
    (target === 'preparation' ? preparation : request).abort();
    expect(await stopped).toMatchObject({ done: true });
    await vi.waitFor(() => expect(setup.model.closed).toBe(1));
    expect(prepared.context.toolContext.signal?.aborted).toBe(true);
    expect(prepared.cleanup.closed).toBe(1);
    setup.model.handle = (_request, response) => answer(response, ['Recovered after Stop.']);
    const recovered = await setup.sessionContext({});
    expect((await events(recovered.session)).filter(event => event.kind === 'text'))
      .toEqual([{ kind: 'text', content: 'Recovered after Stop.' }]);
    expect(setup.model.requests).toHaveLength(2);
  });

  it('cancels native snapshot collection before token publication and closes the provider connection', async () => {
    const setup = await fixture();
    setup.model.handle = (_request, response) => begin(response);
    const prepared = await setup.sessionContext();
    const request = new AbortController();
    const entered = nextRequest(setup.model);
    const output = tokens(prepared.session, request.signal);
    await entered;
    request.abort();
    expect(await output).toEqual([]);
    expect(prepared.cleanup.closed).toBe(1);
    await vi.waitFor(() => expect(setup.model.closed).toBe(1));
    setup.model.handle = (_body, response) => answer(response, ['Recovered native tokens.']);
    expect(await tokens((await setup.sessionContext({})).session)).toEqual(['Recovered native tokens.']);
  });

  it.each(['tokens', 'events'] as const)('closes failed native %s sessions and recovers after a rejected provider key', async surface => {
    const setup = await fixture();
    setup.model.handle = (_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'local-model-secret rejected', type: 'request_error' } }));
    };
    const prepared = await setup.sessionContext();
    const output = surface === 'tokens' ? tokens(prepared.session) : events(prepared.session);
    await expect(output).rejects.toMatchObject({ status: 502, message: 'Local provider request failed (401). The API key was rejected. Check it in Settings.' });
    expect(prepared.cleanup.closed).toBe(1);
    setup.model.handle = (_request, response) => answer(response, ['Recovered provider key.']);
    const recovered = await setup.sessionContext({});
    const result = surface === 'tokens' ? await tokens(recovered.session) : await events(recovered.session);
    expect(result).toContainEqual(surface === 'tokens' ? 'Recovered provider key.' : { kind: 'text', content: 'Recovered provider key.' });
    expect(recovered.cleanup.closed).toBe(1);
  });

  it('stops publishing collected native token pieces after the user aborts between pieces', async () => {
    const setup = await fixture();
    const answerText = 'A native answer that spans multiple token pieces. '.repeat(20);
    setup.model.handle = (_request, response) => answer(response, [answerText]);
    const prepared = await setup.sessionContext();
    const stop = new AbortController();
    const stream = prepared.session.tokens(stop.signal);
    expect(await stream.next()).toEqual({ done: false, value: answerText.slice(0, 256) });
    stop.abort();
    expect(await stream.next()).toMatchObject({ done: true });
    expect(prepared.cleanup.closed).toBe(1);
    expect(await new CanvasStore(setup.root).getCanvas(setup.canvas.id)).toEqual(setup.canvas);
    const recovered = await setup.sessionContext();
    expect((await tokens(recovered.session)).join('')).toBe(answerText);
  });

});
