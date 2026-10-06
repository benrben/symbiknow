import { strict as assert } from 'node:assert';
import * as sdk from '../dist/sdk/sdk.js';
import { openProvider, questions, state, validAnswers } from './engine-provider.js';

const provider = await openProvider();
try {
  const answers = await sdk.decideWithJev('smoke-local-key', state, questions(sdk), provider.fetcher);
  assert.deepEqual(answers, validAnswers);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].authorization, 'Bearer smoke-local-key');
  assert.equal(sdk.noulAnswer(answers, 'eligible'), 0.25);
  console.log('SMOKE=PASS built SDK imports and completes a real HTTP decision with all three question types.');
} finally {
  await provider.close();
}
