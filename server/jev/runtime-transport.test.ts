import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasStore } from '../storage.js';
import type { JevEvaluationContext } from './actions/context.js';
import { currentDocumentTransport } from './runtime-transport.js';

afterEach(() => vi.unstubAllEnvs());

it('keeps a current document transport and tracks cloned contexts at the original version', async () => {
  const current = {} as JevEvaluationContext;
  const versions = new WeakMap<JevEvaluationContext, number>();
  const secretSettings = vi.fn(async () => ({ secrets: { TYPESAFE_API_KEY: 'saved' } }));
  const store = { secretSettings } as unknown as Pick<CanvasStore, 'secretSettings'>;
  expect(await currentDocumentTransport(current, versions, 3, 3, {}, store)).toBe(current);
  expect(versions.get(current)).toBe(3);
  expect(await currentDocumentTransport(current, versions, 2, 3, {}, store)).toBe(current);
  expect(secretSettings).not.toHaveBeenCalled();
});

it('refreshes a stale document transport using explicit, saved, or environment keys', async () => {
  const versions = new WeakMap<JevEvaluationContext, number>();
  const secretSettings = vi.fn(async () => ({ secrets: { TYPESAFE_API_KEY: 'saved' } }));
  const store = { secretSettings } as unknown as Pick<CanvasStore, 'secretSettings'>;
  const explicit = {} as JevEvaluationContext; versions.set(explicit, 1);
  const decider = vi.fn();
  const chosen = await currentDocumentTransport(explicit, versions, 1, 2, { apiKey: 'explicit', decider }, store);
  expect(chosen).not.toBe(explicit); expect(chosen).toMatchObject({ apiKey: 'explicit', decider });
  expect(versions.get(chosen)).toBe(2); expect(secretSettings).not.toHaveBeenCalled();
  const saved = await currentDocumentTransport({} as JevEvaluationContext, versions, 1, 2, {}, store);
  expect(saved.apiKey).toBe('saved'); expect(secretSettings).toHaveBeenCalledTimes(1);
  vi.stubEnv('TYPESAFE_API_KEY', 'environment');
  const environment = await currentDocumentTransport({} as JevEvaluationContext, versions, 1, 2, {},
    { secretSettings: async () => ({ secrets: {} }) } as unknown as Pick<CanvasStore, 'secretSettings'>);
  expect(environment.apiKey).toBe('environment');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const absent = await currentDocumentTransport({} as JevEvaluationContext, versions, 1, 2, {},
    { secretSettings: async () => ({}) } as unknown as Pick<CanvasStore, 'secretSettings'>);
  expect(absent.apiKey).toBe('');
});
