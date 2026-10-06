import type { RouteContext } from './api-context.js';
import type { JevPrincipal } from '../shared/jev-types.js';
import { ApiError } from './errors.js';
import { decideWithJev, JEV_MODEL, noul } from './jev.js';

/** Validate the configured provider without including workspace content. */
export async function checkJevConnection(context: RouteContext, principal: JevPrincipal) {
  if (!principal.canConfigure || principal.kind !== 'user') throw new ApiError(403, 'Only the workspace owner can test this connection');
  const settings = await context.store.secretSettings();
  const key = settings.secrets?.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY || '';
  await decideWithJev(key, { connectionProbe: true }, { available: noul('Does the supplied connectionProbe equal true?') }, context.fetcher,
    { signal: context.signal, maxRetries: 0 });
  return { connected: true, provider: 'TypeSafe', model: JEV_MODEL, documentsSent: 0 };
}
