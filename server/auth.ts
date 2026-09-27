import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** Lets in-process callers, such as the HTTP MCP endpoint, reach the API over loopback. */
export const internalToken = randomBytes(24).toString('hex');

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Current and legacy access tokens may coexist during a credential migration. */
export function accessTokens(): string[] {
  return [...new Set([process.env.SYMBIKNOW_ACCESS_TOKEN, process.env.ALLTEAM_ACCESS_TOKEN].filter((value): value is string => Boolean(value)))];
}

/** Preferred token for issuing new browser sessions. */
export function accessToken(): string {
  return accessTokens()[0] || '';
}

function sessionValue(token: string, legacy = false): string {
  return createHmac('sha256', token).update(legacy ? 'allteam-session-v1' : 'symbiknow-session-v1').digest('hex');
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function bearerToken(request: IncomingMessage): string {
  const match = /^Bearer\s+(.+)$/i.exec(header(request, 'authorization'));
  return match ? match[1].trim() : '';
}

function cookie(request: IncomingMessage, name: string): string {
  for (const part of header(request, 'cookie').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

export function isInternal(request: IncomingMessage): boolean {
  const presented = bearerToken(request);
  return Boolean(presented) && safeEqual(presented, internalToken);
}

export function hasApiAccess(request: IncomingMessage): boolean {
  const tokens = accessTokens();
  if (!tokens.length || isInternal(request)) return true;
  const presented = bearerToken(request);
  if (presented && tokens.some(token => safeEqual(presented, token))) return true;
  const session = cookie(request, 'symbiknow_session');
  const legacySession = cookie(request, 'allteam_session');
  return tokens.some(token => (Boolean(session) && safeEqual(session, sessionValue(token)))
    || (Boolean(legacySession) && safeEqual(legacySession, sessionValue(token, true))));
}

export function validAccessToken(value: unknown): boolean {
  return typeof value === 'string' && accessTokens().some(token => safeEqual(value, token));
}

function secureRequest(request: IncomingMessage): boolean {
  return header(request, 'x-forwarded-proto').split(',')[0].trim() === 'https' || Boolean((request.socket as TLSSocket).encrypted);
}

export function sessionCookie(request: IncomingMessage): string {
  const secure = secureRequest(request) ? '; Secure' : '';
  return `symbiknow_session=${sessionValue(accessToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`;
}

export function clearedSessionCookie(): string[] {
  return ['symbiknow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'allteam_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'];
}

/** Who made a change, used as the Git author of document revisions. Informational, not an access control. */
export function requestActor(request: IncomingMessage, fallback = 'api'): string {
  return cleanActor(header(request, 'x-symbiknow-actor') || header(request, 'x-allteam-actor')) || fallback;
}

export function cleanActor(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-zA-Z0-9 ._:@/-]/g, '').trim().slice(0, 48) : '';
}

/** The public origin agents should use, from PUBLIC_URL or the request's forwarded host. */
export function publicOrigin(request: IncomingMessage): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = header(request, 'x-forwarded-host').split(',')[0].trim() || header(request, 'host');
  return `${secureRequest(request) ? 'https' : 'http'}://${host}`;
}
