import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<{ signal?: AbortSignal; tool?: string }>();
export function mcpCallSignal(): AbortSignal | undefined { return context.getStore()?.signal; }
export function mcpCallTool(): string | undefined { return context.getStore()?.tool; }
export async function withinMcpCall<T>(extra: unknown, tool: string, operation: () => Promise<T>): Promise<T> {
  const signal = (extra as { signal?: AbortSignal; tool?: string } | undefined)?.signal;
  signal?.throwIfAborted();
  return context.run({ signal, tool }, operation);
}
