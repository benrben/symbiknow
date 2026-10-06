import { ApiError } from './storage.js';

function rejectedRequestReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/context.length|too.many.tokens|maximum.*tokens|prompt.is.too.long/i.test(message)) return 'The request is too large for this model.';
  return /tool|function.call|schema/i.test(message) ? 'The model rejected the agent tools.' : 'The model rejected this request.';
}

function providerReason(reasons: Record<number, string>, status: number): string {
  return reasons[status] ?? 'Check the provider status and retry.';
}

export function agentFailure(error: unknown, provider: string): never {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
  const status = upstreamStatus(error);
  if (status === 400) throw new ApiError(502, `${provider} request failed (400). ${rejectedRequestReason(error)}`);
  const reasons: Record<number, string> = {
    401: 'The API key was rejected. Check it in Settings.',
    402: 'The account has insufficient credits. Check billing with the provider.',
    403: 'This key cannot use the selected model. Check provider access and Settings.',
    404: 'The selected model was not found. Choose another model in Settings.',
    408: 'The provider timed out. Retry the request.',
    429: 'The provider rate limit was reached. Retry shortly.',
    500: 'The provider had an internal error. Retry shortly.',
    502: 'The provider is unavailable. Retry shortly.',
    503: 'The provider is unavailable. Retry shortly.',
    504: 'The provider timed out. Retry the request.',
  };
  if (status) throw new ApiError(502, `${provider} request failed (${status}). ${providerReason(reasons, status)}`);
  throw new ApiError(502, `${provider} request failed. Check the model and API key in Settings.`);
}

function messageStatus(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  const match = message.match(/(?:error code|status(?: code)?):?\s*(4\d\d|5\d\d)/i)
    ?? message.match(/^\s*(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function validStatus(status: unknown): status is number {
  return typeof status === 'number' && status >= 400 && status <= 599;
}

function statusFromError(item: { status?: unknown; statusCode?: unknown; message?: unknown }): number | undefined {
  const status = item.status ?? item.statusCode;
  return validStatus(status) ? status : messageStatus(item.message);
}

function upstreamStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const item = current as { status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
    const status = statusFromError(item);
    if (status) return status;
    current = item.cause;
  }
  return undefined;
}

