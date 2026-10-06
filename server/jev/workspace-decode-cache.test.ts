import { expect, it } from 'vitest';
import { WorkspaceDecodeCache } from './workspace-decode-cache.js';

function fixture(options?: { maxEntries?: number; maxBytes?: number }) {
  const cache = new WorkspaceDecodeCache(options); const prepared: string[] = [];
  const prepare = (content: string) => { prepared.push(content); JSON.parse(content); return () => JSON.parse(content); };
  const read = (key: string, content = '{"nested":{"value":1}}') => cache.read(key, content, content, prepare);
  return { cache, prepared, read };
}

it('reuses only exact privately captured bytes and gives each reader independent state', () => {
  const { read, prepared } = fixture(); const first = read('one') as { nested: { value: number } };
  first.nested.value = 3;
  expect(read('one')).toEqual({ nested: { value: 1 } }); expect(prepared).toHaveLength(1);
  expect(read('one', '{"nested":{"value":2}}')).toEqual({ nested: { value: 2 } }); expect(prepared).toHaveLength(2);
});
it('forgets obsolete plans before checking a changed invalid checkpoint and recovers afterward', () => {
  const { read, prepared, cache } = fixture(); read('one');
  expect(() => read('one', '{invalid')).toThrow(); read('one'); expect(prepared).toHaveLength(3);
  cache.forget('one'); cache.forget('one'); read('one'); expect(prepared).toHaveLength(4);
});
it('evicts the least recently used workspace and counts changed replacements once', () => {
  const { read, prepared } = fixture({ maxEntries: 2 });
  read('one'); read('two'); read('one'); read('three'); read('one'); read('two');
  expect(prepared).toHaveLength(4);
  read('two', '{"changed":true}'); read('two', '{"changed":true}'); expect(prepared).toHaveLength(5);
});
it('evicts by retained bytes independently of workspace count', () => {
  const { read, prepared } = fixture({ maxBytes: 1150 });
  read('one', '{}'); read('two', '{}'); read('one', '{}'); expect(prepared).toHaveLength(3);
});
it.each([{ maxBytes: 0 }, { maxEntries: 0 }, { maxBytes: 1024 }])('does not retain disabled or oversized plans: %j', options => {
  const { read, prepared } = fixture(options); read('one'); read('one'); expect(prepared).toHaveLength(2);
});
it.each([{ maxBytes: -1 }, { maxBytes: 1.5 }, { maxEntries: -1 }, { maxEntries: Infinity }])('rejects invalid bounded-cache limits: %j', options => {
  expect(() => fixture(options)).toThrow(RangeError);
});
