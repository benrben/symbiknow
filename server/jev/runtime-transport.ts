import { decideWithJev, type JevDecider } from '../jev.js';

export function transportDecider(options: { decider?: JevDecider; fetcher?: typeof fetch }): JevDecider | undefined {
  if (options.decider) return options.decider;
  if (!options.fetcher) return undefined;
  return (key, input, questions, _fetcher, callOptions) => decideWithJev(key, input, questions, options.fetcher, callOptions);
}
