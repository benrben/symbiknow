import { ApiError } from './errors.js';
import { jevRemoteError } from './jev-provider-error.js';
import type { JevCallOptions } from './jev.js';

const endpoint = 'https://api.typesafe.ai/v1/systemone';
const maxResponseBytes = 262_144;
const requestTimeoutMs = 20_000;
const maxBackoffMs = 5_000;
const maxHonoredRetryAfterMs = 10_000;
const retryableStatuses = new Set([429, 500, 502, 503, 504, 529]);

type Request = { apiKey: string; body: string; fetcher: typeof fetch; maxRetries: number; baseDelayMs: number; signal?: AbortSignal };

export async function requestJev(apiKey: string, body: string, fetcher: typeof fetch, options: JevCallOptions): Promise<unknown> {
  return requestWithRetries({ apiKey, body, fetcher, maxRetries: options.maxRetries ?? 2,
    baseDelayMs: options.baseDelayMs ?? 500, signal: options.signal });
}

async function requestWithRetries(request: Request): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    assertNotAborted(request.signal);
    const response = await fetchAttempt(request, attempt);
    if (!response) continue;
    if (response.status === 401) throw new ApiError(502, 'TypeSafe Jev rejected the API key (401). Check the supplied API key.');
    if (response.ok) return boundedJson(response);
    if (await retryResponse(response, request, attempt)) continue;
    throw await remoteFailure(response);
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApiError(499, 'Jev request was cancelled');
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(signal ? [signal, AbortSignal.timeout(requestTimeoutMs)] : [AbortSignal.timeout(requestTimeoutMs)]);
}

async function fetchAttempt(request: Request, attempt: number): Promise<Response | null> {
  try {
    return await request.fetcher(endpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body: request.body, signal: requestSignal(request.signal) });
  } catch {
    assertNotAborted(request.signal);
    if (attempt >= request.maxRetries) throw new ApiError(502, 'Could not reach TypeSafe Jev');
    await sleep(backoffMs(attempt, request.baseDelayMs), request.signal);
    return null;
  }
}

async function retryResponse(response: Response, request: Request, attempt: number): Promise<boolean> {
  if (!retryableStatuses.has(response.status)) return false;
  const retryAfter = retryAfterMs(response.headers.get('retry-after'));
  if (attempt >= request.maxRetries || (retryAfter !== undefined && retryAfter > maxHonoredRetryAfterMs)) return false;
  await sleep(retryAfter ?? backoffMs(attempt, request.baseDelayMs), request.signal);
  return true;
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'Jev returned an empty response');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  while (true) {
    const chunk = await readChunk(reader);
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new ApiError(502, 'Jev response is too large');
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  try { return await reader.read(); }
  catch { throw new ApiError(502, 'Jev response could not be read'); }
}

async function boundedJson(response: Response): Promise<unknown> {
  const body = await boundedBody(response);
  try { return JSON.parse(body) as unknown; }
  catch { throw new ApiError(502, 'Jev returned invalid JSON'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remoteErrorDetail(value: unknown): string {
  if (!object(value)) return '';
  const detail = value.detail;
  if (typeof detail === 'string') return detail.slice(0, 250);
  const errorType = errorTypeDetail(detail);
  if (errorType) return errorType;
  if (Array.isArray(detail)) return detail.slice(0, 2).flatMap(validationDetail).join('; ');
  return typeof value.message === 'string' ? value.message.slice(0, 250) : '';
}

function errorTypeDetail(detail: unknown): string {
  if (object(detail) && typeof detail.error_type === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(detail.error_type)) {
    return detail.error_type.replaceAll('_', ' ');
  }
  return '';
}

function validationDetail(entry: unknown): string[] {
  if (!object(entry) || typeof entry.msg !== 'string') return [];
  const path = Array.isArray(entry.loc) ? entry.loc.filter(part => typeof part === 'string' || typeof part === 'number').join('.') : '';
  return [`${path ? `${path}: ` : ''}${entry.msg}`.slice(0, 250)];
}

async function remoteFailure(response: Response): Promise<ApiError> {
  let detail = '';
  try { detail = remoteErrorDetail(await boundedJson(response)); }
  catch { return jevRemoteError(response.status, statusMessage(response.status, '')); }
  return jevRemoteError(response.status, statusMessage(response.status, detail));
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const base = Math.min(baseDelayMs * 2 ** attempt, maxBackoffMs);
  return base + (Math.random() * 2 - 1) * base * 0.25;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError(499, 'Jev request was cancelled')); return; }
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new ApiError(499, 'Jev request was cancelled')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function statusMessage(status: number, detail: string): string {
  if (status === 429) return 'TypeSafe Jev rate limit reached (429). Try again shortly.';
  if (status === 529) return 'TypeSafe Jev is overloaded (529). Try again shortly.';
  return `Jev request failed (${status})${detail ? `: ${detail}` : ''}`;
}
