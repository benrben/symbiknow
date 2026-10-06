import { ApiError } from './errors.js';

const billingFailures = new WeakSet<ApiError>();
const contextLimitFailures = new WeakSet<ApiError>();

/** Keep the existing public gateway error while retaining the trusted billing classification privately. */
export function jevRemoteError(status: number, message: string): ApiError {
  const error = new ApiError(502, message);
  if (status === 402) billingFailures.add(error);
  if (status === 400 && /\bmax tokens exceeded\b/i.test(message)) contextLimitFailures.add(error);
  return error;
}
export function isJevBillingFailure(error: ApiError): boolean {
  return error.status === 402 || billingFailures.has(error);
}
/** Only native transport failures can authorize an exact automatic bundle split. */
export function isJevContextLimitFailure(error: unknown): boolean {
  return error instanceof ApiError && contextLimitFailures.has(error);
}
