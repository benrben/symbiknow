import { atlasReflexClaims } from './reflex-atlas.mjs';
import { reflexHeldoutClaims, reflexHeldoutDocuments, type ReflexFixtureClaim, type ReflexFixtureDocument } from './reflex-heldout.mjs';

export function selectReflexCorpus(corpus: string, atlasDocuments: readonly ReflexFixtureDocument[]) {
  if (!['atlas', 'heldout', 'heldout-only'].includes(corpus)) throw new Error('Choose atlas, heldout, or heldout-only');
  const original: ReflexFixtureClaim[] = atlasReflexClaims.map(([claim, truth], index) => ({ id: `atlas-${index + 1}`, documentId: 'atlas', claim, truth }));
  return {
    documents: [...(corpus === 'heldout-only' ? [] : atlasDocuments), ...(corpus === 'atlas' ? [] : reflexHeldoutDocuments)],
    claims: [...(corpus === 'heldout-only' ? [] : original), ...(corpus === 'atlas' ? [] : reflexHeldoutClaims)],
  };
}
