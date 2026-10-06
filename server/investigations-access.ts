import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InvestigationPatch, SavedInvestigation } from './investigations-types.js';

export function keyHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }

export function allowed(saved: SavedInvestigation, key: string | undefined): boolean {
  if (saved.visibility === 'shared') return true;
  if (!key) return false;
  // Private records are validated to have a key hash before they reach access checks.
  const expected = Buffer.from(saved.keyHash!, 'hex');
  const supplied = Buffer.from(keyHash(key), 'hex');
  return timingSafeEqual(expected, supplied);
}

export function accessKeyForCreate(visibility: SavedInvestigation['visibility']): string | undefined {
  return visibility === 'private' ? randomBytes(32).toString('base64url') : undefined;
}

export function accessKeyForUpdate(saved: SavedInvestigation, patch: InvestigationPatch): string | undefined {
  return patch.visibility === 'private' && saved.visibility === 'shared' ? randomBytes(32).toString('base64url') : undefined;
}
