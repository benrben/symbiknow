import { describe, expect, it } from 'vitest';
import { normalizeEvidence } from './evidence.js';

const candidate = {
  claim: 'Retries pause after overload.', passage: 'Pause requests after a 429 response.',
  canvasId: 'reliability', documentId: 'retry-policy', documentTitle: 'Retry policy',
  contentHash: 'abc123', checkedAt: '2026-09-28T10:00:00Z',
};

describe('normalizeEvidence', () => {
  it('marks a passage exact only when it occurs literally in the complete source', () => {
    const reference = normalizeEvidence({ ...candidate, sourceText: '# Retry policy\nPause requests after a 429 response.\n' });
    expect(reference).toMatchObject({ claim: candidate.claim, passage: candidate.passage, passageKind: 'exact',
      canvasId: 'reliability', documentId: 'retry-policy', contentHash: 'abc123',
      checkedAt: '2026-09-28T10:00:00.000Z',
      navigation: { kind: 'document', canvasId: 'reliability', blockId: 'retry-policy' } });
    expect(reference).not.toHaveProperty('passageLabel');
    expect(JSON.stringify(reference)).not.toContain('# Retry policy');
  });

  it('labels a paraphrase or unchecked snippet as an approximation', () => {
    const paraphrase = normalizeEvidence({ ...candidate, passage: 'Requests wait after rate limiting.',
      sourceText: '# Retry policy\nPause requests after a 429 response.' });
    const unchecked = normalizeEvidence(candidate);
    expect(paraphrase?.passageKind).toBe('approximation');
    expect(paraphrase?.passageLabel).toContain('open the document to verify');
    expect(unchecked?.passageKind).toBe('approximation');
  });

  it('drops records without a claim, passage, source identity, or valid analysis time', () => {
    expect(normalizeEvidence({ ...candidate, passage: ' ' })).toBeNull();
    expect(normalizeEvidence({ ...candidate, documentId: '' })).toBeNull();
    expect(normalizeEvidence({ ...candidate, checkedAt: 'unknown' })).toBeNull();
  });

  it.each(['claim', 'passage', 'canvasId', 'documentId'] as const)('rejects a blank %s even with a checked source', field => {
    expect(normalizeEvidence({ ...candidate, sourceText: candidate.passage, [field]: ' \t\n ' })).toBeNull();
  });

  it('normalizes line endings for the quote check while preserving the passage and exact provenance', () => {
    const reference = normalizeEvidence({ ...candidate, claim: ' Claim with Ω ', canvasId: ' research ', documentId: ' evidence ',
      passage: ' Line one\r\nLine two\rLine three ', sourceText: '# Private heading\nLine one\nLine two\nLine three\nPrivate remainder',
      revision: 'native-commit-123', checkedAt: '2026-09-28T13:00:00+03:00' });
    expect(reference).toEqual({ claim: 'Claim with Ω', passage: 'Line one\r\nLine two\rLine three', passageKind: 'exact',
      canvasId: 'research', documentId: 'evidence', documentTitle: candidate.documentTitle, contentHash: candidate.contentHash,
      revision: 'native-commit-123', checkedAt: '2026-09-28T10:00:00.000Z', navigation: { kind: 'document', canvasId: 'research', blockId: 'evidence' } });
    expect(JSON.stringify(reference)).not.toContain('Private');
  });

  it.each([undefined, ''])('keeps missing optional provenance omitted (%s)', absent => {
    const reference = normalizeEvidence({ ...candidate, documentTitle: absent, contentHash: absent, revision: absent, sourceText: '' });
    expect(reference).toMatchObject({ passageKind: 'approximation', passageLabel: 'Approximate source context; open the document to verify the claim.' });
    expect(reference).not.toHaveProperty('documentTitle'); expect(reference).not.toHaveProperty('contentHash'); expect(reference).not.toHaveProperty('revision');
  });
});
