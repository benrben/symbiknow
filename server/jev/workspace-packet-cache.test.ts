import { expect, it } from 'vitest';
import { WorkspacePacketCache } from './workspace-packet-cache.js';

it('bounds the default cache at 64 entries and promotes exact-digest hits', () => {
  const cache = new WorkspacePacketCache<{ id: number }>();
  for (let id = 0; id < 64; id += 1) cache.set(String(id), 'saved', { id });
  expect(cache.get('0', 'saved')).toEqual({ id: 0 });
  cache.set('64', 'saved', { id: 64 });
  expect(cache.get('1', 'saved')).toBeUndefined();
  expect(cache.get('0', 'saved')).toEqual({ id: 0 });
  expect(cache.get('64', 'saved')).toEqual({ id: 64 });
  expect(cache.get('missing', 'saved')).toBeUndefined();
});

it('evicts the least recently read packet under an explicit entry limit', () => {
  const cache = new WorkspacePacketCache<number>({ maxEntries: 2 });
  cache.set('a', 'a1', 1); cache.set('b', 'b1', 2);
  expect(cache.get('a', 'a1')).toBe(1);
  cache.set('c', 'c1', 3);
  expect(cache.get('b', 'b1')).toBeUndefined();
  expect(cache.get('a', 'a1')).toBe(1);
  expect(cache.get('c', 'c1')).toBe(3);
});

it('evicts under the byte budget even when the entry budget has space', () => {
  const cache = new WorkspacePacketCache<{ text: string }>({ maxEntries: 10, maxBytes: 1000 });
  cache.set('first', 'version', { text: 'a'.repeat(160) });
  expect(cache.get('first', 'version')).toEqual({ text: 'a'.repeat(160) });
  cache.set('next', 'version', { text: 'b'.repeat(160) });
  expect(cache.get('first', 'version')).toBeUndefined();
  expect(cache.get('next', 'version')).toEqual({ text: 'b'.repeat(160) });
});

it('replaces growing packets without retaining the older value or double-counting it', () => {
  const cache = new WorkspacePacketCache<{ text: string }>({ maxEntries: 2, maxBytes: 1500 });
  cache.set('one', 'old', { text: 'a'.repeat(160) });
  cache.set('two', 'current', { text: 'short' });
  cache.set('one', 'new', { text: 'b'.repeat(500) });
  expect(cache.get('two', 'current')).toBeUndefined();
  expect(cache.get('one', 'new')).toEqual({ text: 'b'.repeat(500) });
});

it('releases replaced packet bytes when a projection shrinks', () => {
  const cache = new WorkspacePacketCache<{ text: string }>({ maxEntries: 2, maxBytes: 1100 });
  cache.set('one', 'old', { text: 'a'.repeat(250) });
  cache.set('one', 'new', { text: 'small' });
  cache.set('two', 'new', { text: 'small' });
  expect(cache.get('one', 'new')).toEqual({ text: 'small' });
  expect(cache.get('two', 'new')).toEqual({ text: 'small' });
});

it('deletes a stale digest and makes its capacity available instead of returning an older packet', () => {
  const cache = new WorkspacePacketCache<string>({ maxEntries: 2 });
  cache.set('workspace', 'digest', 'old'); cache.set('other', 'digest', 'other');
  expect(cache.get('workspace', 'digest ')).toBeUndefined();
  expect(cache.get('workspace', 'digest')).toBeUndefined();
  cache.set('next', 'digest', 'next');
  expect(cache.get('other', 'digest')).toBe('other');
  expect(cache.get('next', 'digest')).toBe('next');
});

it('owns independent clones on both set and get, including nested arrays and aliases', () => {
  const shared = { values: ['original'], present: true, count: 2, empty: null };
  const packet = { left: shared, right: shared };
  const cache = new WorkspacePacketCache<typeof packet>();
  cache.set('workspace', 'digest', packet);
  shared.values.push('input mutation'); shared.present = false;
  const first = cache.get('workspace', 'digest')!;
  expect(first.left).toBe(first.right);
  expect(first.left).toEqual({ values: ['original'], present: true, count: 2, empty: null });
  first.left.values.push('reader mutation'); first.right.count = 9;
  const second = cache.get('workspace', 'digest')!;
  expect(second.left).toEqual({ values: ['original'], present: true, count: 2, empty: null });
  expect(second).not.toBe(first); expect(second.left).not.toBe(shared);
});

it('accounts for UTF16 key, digest, array and property overhead under small budgets', () => {
  const cache = new WorkspacePacketCache<unknown>({ maxEntries: 10, maxBytes: 500 });
  cache.set('small', 'digest', null);
  expect(cache.get('small', 'digest')).toBeNull();
  cache.set('x'.repeat(120), 'digest', null);
  cache.set('other', 'x'.repeat(120), null);
  cache.set('array', 'digest', Array.from({ length: 20 }, () => false));
  cache.set('properties', 'digest', Object.fromEntries(Array.from({ length: 10 }, (_, id) => ['value-' + id, null])));
  expect(cache.get('x'.repeat(120), 'digest')).toBeUndefined();
  expect(cache.get('other', 'x'.repeat(120))).toBeUndefined();
  expect(cache.get('array', 'digest')).toBeUndefined();
  expect(cache.get('properties', 'digest')).toBeUndefined();
  expect(cache.get('small', 'digest')).toBeNull();
});

it.each([{ maxEntries: 0 }, { maxBytes: 0 }, { maxEntries: 0, maxBytes: 0 }])('does not retain packets with zero capacity %j', options => {
  const cache = new WorkspacePacketCache<number>(options);
  cache.set('workspace', 'digest', 1);
  expect(cache.get('workspace', 'digest')).toBeUndefined();
  cache.forget('workspace');
});

it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid limit %s', limit => {
  expect(() => new WorkspacePacketCache({ maxEntries: limit })).toThrow(RangeError);
  expect(() => new WorkspacePacketCache({ maxBytes: limit })).toThrow(RangeError);
});

it('skips oversized packets, clears an oversized replacement, and remains usable afterward', () => {
  const cache = new WorkspacePacketCache<string>({ maxBytes: 1000 });
  cache.set('workspace', 'old', 'small');
  cache.set('workspace', 'new', 'x'.repeat(1000));
  expect(cache.get('workspace', 'old')).toBeUndefined();
  expect(cache.get('workspace', 'new')).toBeUndefined();
  cache.set('workspace', 'latest', 'latest');
  expect(cache.get('workspace', 'latest')).toBe('latest');
});

it('forgets known and unknown packets safely and releases the byte budget', () => {
  const cache = new WorkspacePacketCache<{ text: string }>({ maxBytes: 1000 });
  cache.set('one', 'digest', { text: 'a'.repeat(160) });
  cache.forget('missing');
  expect(cache.get('one', 'digest')).toBeDefined();
  cache.forget('one'); cache.forget('one');
  expect(cache.get('one', 'digest')).toBeUndefined();
  cache.set('two', 'digest', { text: 'b'.repeat(160) });
  expect(cache.get('two', 'digest')).toEqual({ text: 'b'.repeat(160) });
});
