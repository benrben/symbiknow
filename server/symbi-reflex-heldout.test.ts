import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { selectReflexCorpus } from '../scripts/jev-bench/data/reflex-corpora.mjs';
import { reflexHeldoutClaims, reflexHeldoutDocuments } from '../scripts/jev-bench/data/reflex-heldout.mjs';

it('freezes ten independently authored source documents and thirty balanced claim answers before provider evaluation', () => {
  expect(reflexHeldoutDocuments).toHaveLength(10);
  expect(reflexHeldoutClaims).toHaveLength(30);
  expect(new Set(reflexHeldoutDocuments.map(document => document.id)).size).toBe(10);
  expect(new Set(reflexHeldoutClaims.map(claim => claim.id)).size).toBe(30);
  expect(Object.isFrozen(reflexHeldoutDocuments)).toBe(true);
  expect(Object.isFrozen(reflexHeldoutClaims)).toBe(true);
  for (const fixture of [...reflexHeldoutDocuments, ...reflexHeldoutClaims]) expect(Object.isFrozen(fixture)).toBe(true);
  const digest = createHash('sha256').update(JSON.stringify({ documents: reflexHeldoutDocuments, claims: reflexHeldoutClaims })).digest('hex');
  expect(digest).toBe('75a242c1606bc1ab563d26703e42af39eb317277752ed744b9df133c2a65a4fb');
  expect(reflexHeldoutClaims.reduce((counts, claim) => ({ ...counts, [claim.truth]: (counts[claim.truth] ?? 0) + 1 }), {} as Record<string, number>))
    .toEqual({ yes: 10, no: 10, insufficient_evidence: 10 });
});

it('gives every source a support, contradiction, and explicit missing-fact case with bounded exact source coverage', () => {
  for (const document of reflexHeldoutDocuments) {
    expect(document.content.startsWith(`# ${document.title}\n\n`)).toBe(true);
    expect(document.content.length).toBeGreaterThan(220);
    const cases = reflexHeldoutClaims.filter(claim => claim.documentId === document.id);
    expect(cases.map(claim => claim.truth)).toEqual(['yes', 'no', 'insufficient_evidence']);
    expect(new Set(cases.map(claim => claim.claim)).size).toBe(3);
    for (const claim of cases) {
      if (claim.truth === 'insufficient_evidence') {
        expect(claim.sourceQuote).toBeUndefined();
        expect(claim.missingFact).toMatch(/not stated/);
        expect(document.content).not.toContain(claim.claim);
      } else {
        const quote = claim.sourceQuote!;
        expect(quote.length).toBeGreaterThan(20);
        expect(quote.length).toBeLessThanOrEqual(220);
        const start = document.content.indexOf(quote);
        expect(start).toBeGreaterThan(0);
        expect(document.content.slice(start, start + quote.length)).toBe(quote);
        expect(claim.missingFact).toBeUndefined();
      }
    }
  }
});

it('uses Atlas by default selection and sends synthetic sources only for an explicit heldout corpus', () => {
  const original = [{ id: 'atlas-source', title: 'Atlas example', content: '# Atlas example\nFixture text.' }];
  const atlas = selectReflexCorpus('atlas', original);
  expect(atlas.documents).toEqual(original);
  expect(atlas.claims).toHaveLength(31);
  expect(atlas.claims.every(claim => claim.id.startsWith('atlas-'))).toBe(true);
  const combined = selectReflexCorpus('heldout', original);
  expect(combined.documents).toHaveLength(11);
  expect(combined.claims).toHaveLength(61);
  const isolated = selectReflexCorpus('heldout-only', original);
  expect(isolated.documents).toEqual(reflexHeldoutDocuments);
  expect(isolated.claims).toEqual(reflexHeldoutClaims);
  expect(isolated.documents).not.toContainEqual(original[0]);
  expect(() => selectReflexCorpus('all', original)).toThrow('Choose atlas, heldout, or heldout-only');
});
