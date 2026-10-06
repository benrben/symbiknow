import { expect, it } from 'vitest';
import { SourcePassageCache } from './source-passage-cache';
import type { SourcePassage } from './source-passages';

function passage(quote = 'Exact'): SourcePassage {
  return { start: 0, end: quote.length, quote, text: quote, totalTextLength: quote.length, headingLevel: 0 };
}

it('retains exact source keys with default limits and distinguishes changed evidence bytes', () => {
  const cache = new SourcePassageCache();
  const source = '# Exact source';
  cache.set(source, [passage(source)]);
  expect(cache.get(source)).toEqual([passage(source)]);
  expect(cache.get(source + '\n')).toBeUndefined();
  cache.set(source + '\n', []);
  expect(cache.get(source + '\n')).toEqual([]);
  expect(cache.get(source)).toEqual([passage(source)]);
});

it('isolates both stored input and returned evidence from caller mutations', () => {
  const cache = new SourcePassageCache();
  const input = [passage()];
  cache.set('Exact', input);
  input[0].quote = 'Changed input'; input.push(passage('New'));
  const first = cache.get('Exact')!;
  first[0].start = 99; first[0].text = 'Changed output'; first.pop();
  expect(cache.get('Exact')).toEqual([passage()]);
});

it('evicts the least recently used source at the entry limit and refreshes hits', () => {
  const cache = new SourcePassageCache({ maxEntries: 2 });
  cache.set('one', [passage('one')]); cache.set('two', [passage('two')]);
  expect(cache.get('one')).toEqual([passage('one')]);
  cache.set('three', [passage('three')]);
  expect(cache.get('two')).toBeUndefined();
  expect(cache.get('one')).toEqual([passage('one')]);
  expect(cache.get('three')).toEqual([passage('three')]);
});

it('bounds retained source and evidence strings by bytes rather than entry count', () => {
  const cache = new SourcePassageCache({ maxBytes: 1100, maxEntries: 10 });
  const sources = ['A', 'B', 'C'].map(letter => letter.repeat(120));
  cache.set(sources[0], [passage()]); cache.set(sources[1], [passage()]);
  expect(cache.get(sources[0])).toEqual([passage()]);
  cache.set(sources[2], [passage()]);
  expect(cache.get(sources[1])).toBeUndefined();
  expect(cache.get(sources[0])).toEqual([passage()]);
  expect(cache.get(sources[2])).toEqual([passage()]);
});

it('counts quote and readable text strings, skips oversized entries, and keeps other cached evidence', () => {
  const cache = new SourcePassageCache({ maxBytes: 600 });
  cache.set('small', [passage()]);
  cache.set('large evidence', [passage('😀'.repeat(100))]);
  expect(cache.get('large evidence')).toBeUndefined();
  expect(cache.get('small')).toEqual([passage()]);
  cache.set('large source'.repeat(100), []);
  expect(cache.get('large source'.repeat(100))).toBeUndefined();
});

it('replaces entries without counting removed bytes or retaining obsolete passage values', () => {
  const cache = new SourcePassageCache({ maxBytes: 600 });
  cache.set('same', [passage()]);
  cache.set('same', []);
  cache.set('other', []);
  expect(cache.get('same')).toEqual([]);
  expect(cache.get('other')).toEqual([]);
  cache.set('same', [passage('x'.repeat(300))]);
  expect(cache.get('same')).toBeUndefined();
  expect(cache.get('other')).toEqual([]);
});

it.each([{ maxBytes: 0 }, { maxEntries: 0 }])('supports disabled cache limits %j without retaining entries', limits => {
  const cache = new SourcePassageCache(limits);
  cache.set('source', [passage()]);
  expect(cache.get('source')).toBeUndefined();
});

it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte and entry limits %s', value => {
  expect(() => new SourcePassageCache({ maxBytes: value })).toThrow(RangeError);
  expect(() => new SourcePassageCache({ maxEntries: value })).toThrow(RangeError);
});
