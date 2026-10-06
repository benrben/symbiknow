import { strict as assert } from 'node:assert';
import { After, Given, Then, When } from '@cucumber/cucumber';
import * as sdk from '../../dist/sdk/sdk.js';
import { openProvider, questions, state, validAnswers } from '../engine-provider.js';

Given('a real local Jev provider and the built SDK', async function () {
  this.provider = await openProvider();
  this.questions = questions(sdk);
});

After(async function () { if (this.provider) await this.provider.close(); });

async function call(world, input = state, batch = world.questions, options = {}) {
  return sdk.decideWithJev('acceptance-local-key', input, batch, world.provider.fetcher, { baseDelayMs: 0, ...options });
}

When('I submit choice score and noul questions', async function () {
  this.provider.setReply(() => ({ status: 200, body: { answers: validAnswers } }));
  this.answers = await call(this);
});

Then('the provider receives exactly the caller context and questions', function () {
  assert.deepEqual(this.provider.requests[0], {
    body: { model: sdk.JEV_MODEL, state, questions: this.questions }, authorization: 'Bearer acceptance-local-key',
  });
});

Then('the SDK returns the validated decisions and distributions', function () {
  assert.deepEqual(this.answers, validAnswers);
  assert.deepEqual(sdk.choiceAnswer(this.answers, 'route', ['proceed', 'defer']), { value: 'defer', confidence: 0.8 });
  assert.equal(sdk.topScore(this.answers.priority), 2);
  assert.ok(Math.abs(sdk.expectedScore(this.answers.priority, 3) - 0.8) < 1e-12);
  assert.equal(sdk.noulAnswer(this.answers, 'eligible'), 0.25);
});

When('the provider returns an unoffered choice', async function () {
  this.provider.setReply(() => ({ status: 200, body: { answers: { ...validAnswers, route: { ...validAnswers.route, choice: 'unknown' } } } }));
  await assert.rejects(call(this), error => { this.failure = error; return error instanceof sdk.ApiError; });
});

Then('the SDK rejects the invalid decision', function () {
  assert.equal(this.failure.status, 502);
  assert.equal(this.failure.message, 'Jev returned an invalid answer for route');
});

When('the provider fails once with a transient status', async function () {
  this.provider.setReply((_body, count) => count === 1
    ? { status: 503, body: { message: 'Temporarily unavailable' } }
    : { status: 200, body: { answers: validAnswers } });
  this.answers = await call(this);
});

Then('a retry returns validated decisions after two requests', function () {
  assert.equal(this.provider.requests.length, 2);
  assert.deepEqual(this.answers, validAnswers);
});

When('I cancel before submitting a decision', async function () {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(call(this, state, this.questions, { signal: controller.signal }), error => {
    this.failure = error; return error instanceof sdk.ApiError;
  });
});

Then('the SDK reports cancellation with no provider request', function () {
  assert.equal(this.failure.status, 499);
  assert.equal(this.failure.message, 'Jev request was cancelled');
  assert.equal(this.provider.requests.length, 0);
});

When('I submit an empty question batch', async function () { this.answers = await call(this, state, {}); });
Then('the SDK returns no answers with no provider request', function () {
  assert.deepEqual(this.answers, {});
  assert.equal(this.provider.requests.length, 0);
});

When('I submit state exceeding the decision budget', async function () {
  await assert.rejects(call(this, { text: 'x'.repeat(200_000) }), error => {
    this.failure = error; return error instanceof sdk.ApiError;
  });
});
Then('the SDK rejects the state with no provider request', function () {
  assert.equal(this.failure.status, 413);
  assert.match(this.failure.message, /state is too large/);
  assert.equal(this.provider.requests.length, 0);
});

When('the provider rejects the supplied API key', async function () {
  this.provider.setReply(() => ({ status: 401, body: { message: 'acceptance-local-key' } }));
  await assert.rejects(call(this), error => { this.failure = error; return error instanceof sdk.ApiError; });
});
Then('the SDK returns a safe credential diagnostic', function () {
  assert.equal(this.failure.status, 502);
  assert.equal(this.failure.message, 'TypeSafe Jev rejected the API key (401). Check the supplied API key.');
  assert.equal(this.failure.message.includes('acceptance-local-key'), false);
  assert.equal(this.provider.requests.length, 1);
});
