import { AsyncLocalStorage } from 'node:async_hooks';

const authority = new AsyncLocalStorage<(() => Promise<void>) | undefined>();

/** Storage queues capture the API authority of their originating request. */
export function captureApiMutationAuthority(): (() => Promise<void>) | undefined {
  const check = authority.getStore();
  return check ? () => authority.run(undefined, check) : undefined;
}

export function withinApiMutationAuthority<T>(check: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  return authority.run(check, operation);
}
