import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeepAgentFactory } from './chat-agent.js';
import type { CanvasStore } from './storage.js';
import type { SymbiIndexLifecycle } from './symbi-index-lifecycle.js';
import type { SymbiJudgmentCache } from './symbi-judgment-cache.js';

export type RouteContext = { store: CanvasStore; request: IncomingMessage; response: ServerResponse;
  symbiIndex?: SymbiIndexLifecycle;
  symbiJudgments?: SymbiJudgmentCache;
  method: string; route: string; url: URL; fetcher?: typeof fetch; agentFactory?: DeepAgentFactory;
  actor: string; signal: AbortSignal };
