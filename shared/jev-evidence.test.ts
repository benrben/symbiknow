import { describe, expect, it } from 'vitest';
import { normalizeEvidence } from './evidence.js';
import { jevEvidenceReference } from './jev-evidence.js';
import { documentReviewState } from './document-state.js';
import type { CanvasBlock } from './types.js';

const sourceText = '# Result\r\nΩ: complete.\nPrivate remainder';
const start = sourceText.indexOf('Ω');
const evidence = { quote: 'Ω: complete.', start, end: start + 'Ω: complete.'.length,
  source: { workspaceId: 'team', canvasId: 'canvas', blockId: 'doc', incarnation: 'incarnation-2',
    sourceGeneration: 3, metadataRevision: 8, contentHash: 'current-hash' } };
const date = '2026-10-03T10:00:00Z';

describe('revision-bound source evidence', () => {
  it('preserves the exact raw offsets and revisions without copying private source context', () => {
    const reference = jevEvidenceReference('The declared work is complete.', evidence, sourceText, date, 'Result');
    expect(reference).toMatchObject({ passageKind: 'exact', passage: evidence.quote,
      incarnation: 'incarnation-2', sourceGeneration: 3, metadataRevision: 8,
      start: evidence.start, end: evidence.end, contentHash: 'current-hash', documentTitle: 'Result' });
    expect(JSON.stringify(reference)).not.toContain('Private');
  });

  it.each([
    { start: undefined }, { end: undefined }, { start: -1 }, { start: 1.5 }, { end: 1.5 },
    { start: evidence.end }, { end: 1000 }, { start: evidence.start + 1 },
  ])('rejects invalid or mismatched offsets %j', offsets => {
    expect(jevEvidenceReference('Completion', { ...evidence, ...offsets } as typeof evidence, sourceText, date)).toBeNull();
  });

  it('rejects stale offsets when the current source changed even if the quote still appears elsewhere', () => {
    expect(jevEvidenceReference('Completion', evidence, `New heading\n${sourceText}`, date)).toBeNull();
  });

  it('accepts legacy unchecked evidence without inventing offsets or revisions', () => {
    const reference = normalizeEvidence({ claim: 'Claim', passage: 'Context', canvasId: 'canvas', documentId: 'doc', checkedAt: date });
    expect(reference?.passageKind).toBe('approximation');
    expect(reference).not.toHaveProperty('sourceGeneration');
    expect(reference).not.toHaveProperty('start');
  });

  it('refuses exact offsets when the complete source is unavailable', () => {
    expect(normalizeEvidence({ claim: 'Completion', passage: evidence.quote, canvasId: 'canvas', documentId: 'doc',
      start: evidence.start, end: evidence.end, checkedAt: date })).toBeNull();
  });

  it.each([{ incarnation: ' ' }, { sourceGeneration: 0 }, { sourceGeneration: 1.5 },
    { metadataRevision: -1 }, { metadataRevision: Infinity }])('rejects invalid revision %j', revision => {
    expect(jevEvidenceReference('Completion', { ...evidence, source: { ...evidence.source, ...revision } }, sourceText, date)).toBeNull();
  });
});

describe('document review preconditions', () => {
  const block = { id: 'doc', title: 'Document', content: 'Source', contentHash: 'hash', file: 'doc.md',
    kind: 'markdown', x: 0, y: 0, width: 200, height: 100, links: [], quality: { score: 0, at: date } } as CanvasBlock;

  it.each([{ headline: 'New headline' }, { freshness: { reviewAt: date } }, { processingExcluded: true },
    { jevOwnership: { pins: ['headline'], managed: [], removedLabels: [], removedLinks: [] } }])('guards logical changes %j', patch => {
    expect(documentReviewState({ ...block, ...patch })).not.toBe(documentReviewState(block));
  });

  it('does not confuse bookkeeping with a logical document edit', () => {
    expect(documentReviewState({ ...block, incarnation: 'inc', sourceGeneration: 10, metadataRevision: 20,
      jevMutationId: 'receipt' })).toBe(documentReviewState(block));
  });

  it('treats saved link types canonically regardless of insertion order', () => {
    expect(documentReviewState({ ...block, linkTypes: { z: 'implements', a: 'prerequisite' } }))
      .toBe(documentReviewState({ ...block, linkTypes: { a: 'prerequisite', z: 'implements' } }));
  });
});
