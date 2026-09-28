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
});
