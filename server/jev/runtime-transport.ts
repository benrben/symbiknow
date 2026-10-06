import { decideWithJev, type JevDecider } from '../jev.js';
import type { CanvasStore } from '../storage.js';
import type { JevEvaluationContext } from './actions/context.js';

export function transportDecider(options: { decider?: JevDecider; fetcher?: typeof fetch }): JevDecider | undefined {
  if (options.decider) return options.decider;
  if (!options.fetcher) return undefined;
  return (key, input, questions, _fetcher, callOptions) => decideWithJev(key, input, questions, options.fetcher, callOptions);
}

export async function currentDocumentTransport(current: JevEvaluationContext,
  versions: WeakMap<JevEvaluationContext, number>, initialVersion: number, activeVersion: number,
  options: { apiKey?: string; decider?: JevDecider; fetcher?: typeof fetch },
  store: Pick<CanvasStore, 'secretSettings'>): Promise<JevEvaluationContext> {
  if (!versions.has(current)) versions.set(current, initialVersion);
  if (versions.get(current) === activeVersion) return current;
  const refreshed = { ...current,
    apiKey: options.apiKey ?? (await store.secretSettings()).secrets?.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY,
    decider: transportDecider(options) };
  versions.set(refreshed, activeVersion);
  return refreshed;
}
