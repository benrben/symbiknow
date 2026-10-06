import { expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { isJevBillingFailure, isJevContextLimitFailure, jevRemoteError } from './jev-provider-error.js';

it('keeps the public gateway contract while privately identifying a trusted billing response', () => {
  const billing = jevRemoteError(402, 'Jev request failed (402): billing error');
  expect(billing).toMatchObject({ status: 502, message: 'Jev request failed (402): billing error' });
  expect(isJevBillingFailure(billing)).toBe(true);
  expect(Object.keys(billing)).not.toContain('upstreamStatus');
  expect(isJevBillingFailure(new ApiError(502, billing.message))).toBe(false);
});
it('classifies only trusted upstream400 token-limit responses for bundle recovery', () => {
  const error = jevRemoteError(400, 'Jev request failed (400): MAX TOKENS EXCEEDED');
  expect(error).toMatchObject({ status: 502, message: 'Jev request failed (400): MAX TOKENS EXCEEDED' });
  expect(isJevContextLimitFailure(error)).toBe(true);
  expect(isJevContextLimitFailure(new ApiError(502, error.message))).toBe(false);
  expect(isJevContextLimitFailure(jevRemoteError(400, 'invalid question'))).toBe(false);
  expect(isJevContextLimitFailure(jevRemoteError(503, 'max tokens exceeded'))).toBe(false);
  expect(isJevContextLimitFailure('max tokens exceeded')).toBe(false);
});
it('retains transient failure handling and direct native billing classification', () => {
  expect(isJevBillingFailure(jevRemoteError(503, 'Unavailable'))).toBe(false);
  expect(isJevBillingFailure(new ApiError(402, 'Billing unavailable'))).toBe(true);
});
