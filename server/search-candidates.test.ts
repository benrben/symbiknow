import { describe, expect, it } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import { searchCandidates } from './search-candidates.js';

const checkedAt = '2026-09-29T00:00:00.000Z';

function block(id: string, title: string, content: string, archived = false): CanvasBlock {
  return { id, title, content, archived, contentHash: `hash-${id}`, file: `${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 300, links: [] };
}

function canvas(name: string, blocks: CanvasBlock[]): CanvasDocument {
  return { id: name.toLocaleLowerCase(), workspaceId: 'workspace', name, blocks };
}

describe('bounded lexical search candidates', () => {
  it('prefers exact title and body matches and keeps an exact saved passage as evidence', () => {
    const canvases = [canvas('Planning', [
      block('body', 'Operations', '# Operations\nThe release checklist is ready.'),
      block('title', 'Release checklist', '# Another document\nNo checklist details.'),
    ])];
    const hits = searchCandidates(canvases, 'release checklist', { checkedAt });
    expect(hits.map(hit => hit.blockId)).toEqual(['title', 'body']);
    expect(hits.map(hit => hit.retrieval.kind)).toEqual(['exact', 'exact']);
    expect(hits.map(hit => hit.matchIn)).toEqual(['title', 'body']);
    expect(hits[1].evidence).toMatchObject({ passage: 'The release checklist is ready.', passageKind: 'exact',
      contentHash: 'hash-body', checkedAt, navigation: { canvasId: 'planning', blockId: 'body' } });
  });

  it('recovers separated terms and a one-edit title typo without claiming semantic recall', () => {
    const canvases = [canvas('Planning', [
      block('terms', 'QA notes', 'Beta testing found several release blockers.'),
      block('typo', 'Launch checklist', 'Tasks for launch.'),
      block('unrelated', 'Budget', 'Finance totals.'),
    ])];
    const terms = searchCandidates(canvases, 'beta release tests', { checkedAt });
    expect(terms.map(hit => hit.blockId)).toEqual(['terms']);
    expect(terms[0].retrieval).toEqual({ kind: 'terms', matchedTerms: ['beta', 'release'] });
    const typo = searchCandidates(canvases, 'checklst', { checkedAt });
    expect(typo.map(hit => hit.blockId)).toEqual(['typo']);
    expect(typo[0].retrieval).toEqual({ kind: 'fuzzy_title', matchedTerms: ['checklst'] });
  });

  it('ranks an adjacent query phrase above scattered term matches', () => {
    const source = [canvas('Planning', [
      block('phrase', 'QA update', 'The beta release is ready for review.'),
      block('scattered', 'QA release', 'Launch planning includes beta testing.'),
    ])];
    const hits = searchCandidates(source, 'launch beta release', { checkedAt });
    expect(hits.map(hit => hit.blockId)).toEqual(['phrase', 'scattered']);
    expect(hits[0].retrieval.kind).toBe('phrase');
    expect(hits[1].retrieval.kind).toBe('terms');
  });

  it('uses readable HTML text, excludes archived documents, and caps deterministic output', () => {
    const html = block('html', 'Page', '---\nformat: html\n---\n<html><style>.secret{color:red}</style><body><p>Release review passed.</p><script>hidden launch</script></body></html>');
    const blocks = [html, block('archived', 'Release archived', 'Release review', true),
      ...Array.from({ length: 105 }, (_, index) => block(`item-${String(index).padStart(3, '0')}`, `Release item ${index}`, '# Release'))];
    const source = [canvas('Planning', blocks)];
    expect(searchCandidates(source, 'secret', { checkedAt })).toEqual([]);
    expect(searchCandidates(source, 'hidden launch', { checkedAt })).toEqual([]);
    expect(searchCandidates(source, 'review passed', { checkedAt }).map(hit => hit.blockId)).toEqual(['html']);
    const first = searchCandidates(source, 'release', { checkedAt, limit: 150 });
    const second = searchCandidates(source, 'release', { checkedAt, limit: 150 });
    expect(first).toHaveLength(100);
    expect(first).toEqual(second);
    expect(first.some(hit => hit.blockId === 'archived')).toBe(false);
  });

  it('handles a short exact query without token matches', () => {
    const hits = searchCandidates([canvas('Planning', [block('short', 'Q1 plan', '# Results')])], 'Q1', { checkedAt });
    expect(hits).toMatchObject([{ blockId: 'short', retrieval: { kind: 'exact' } }]);
  });

  it('matches numeric-leading error codes and ignores generic question words', () => {
    const source = [canvas('Planning', [
      block('code', 'Retry policy', 'HTTP 429 means requests should pause before retrying.'),
      block('generic', 'How to handle onboarding', 'A guide to handling new starters.'),
    ])];
    expect(searchCandidates(source, '429', { checkedAt }).map(hit => hit.blockId)).toEqual(['code']);
    expect(searchCandidates(source, 'how do we handle 429s?', { checkedAt })).toEqual([]);
    expect(searchCandidates(source, 'how to handle onboarding', { checkedAt }).map(hit => hit.blockId)).toEqual(['generic']);
  });
});
