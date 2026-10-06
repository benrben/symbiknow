import { expect, it } from 'vitest';
import type { JevSourceSnapshot, JevWorkspaceState } from '../../shared/jev-types.js';
import { automationPrincipal } from './authorization.js';
import type { StoredJevJob } from './runtime-queue.js';
import { encodeJevWorkspace, validateJevWorkspacePool } from './workspace-codec.js';
import { decodeJevWorkspace } from './workspace-codec.js';
import { emptyJevWorkspace } from './workspace.js';

type Encoded = { state: JevWorkspaceState; sources: JevSourceSnapshot[]; vectors: number[][];
  references: Array<{ path: Array<string | number>; vector: number }> };
const sources: JevSourceSnapshot[] = Array.from({ length: 158 }, (_, index) => ({ workspaceId: 'workspace', canvasId: 'canvas',
  blockId: `source-${index}`, incarnation: `incarnation-${index}`, sourceGeneration: 1, metadataRevision: index, contentHash: `exact-hash-${index}` }));
function history(): Encoded {
  const state = emptyJevWorkspace(); const now = '2026-10-04T00:00:00.000Z';
  state.jobs = Array.from({ length: 200 }, (_, index): StoredJevJob => ({ id: `history-${index}`, state: 'completed',
    request: { action: 'profile', canvasId: 'canvas', blockIds: [sources[index % sources.length].blockId] },
    createdAt: now, updatedAt: now, sources: [sources[index % sources.length]], contextSources: sources, followupSources: sources,
    principal: automationPrincipal, attempts: 1, settingsKey: 'checked-settings', authorizationFingerprint: 'checked-authorization',
    proposalIds: [], result: { status: 'profiled', exactSourceText: 'Keep literal historical analysis.' } }));
  return JSON.parse(JSON.stringify(encodeJevWorkspace(state))) as Encoded;
}

it('validates each recognized source field once without copying unrelated records in a genuine encoded 200-job history', () => {
  const encoded = history(); let sourceReads = 0; let unrelatedReads = 0;
  expect(encoded.sources).toHaveLength(158); expect(encoded.references).toHaveLength(600);
  for (const job of encoded.state.jobs as StoredJevJob[]) {
    for (const field of ['sources', 'contextSources', 'followupSources'] as const) {
      const placeholder = job[field];
      Object.defineProperty(job, field, { enumerable: true, configurable: true,
        get: () => { sourceReads++; return placeholder; } });
    }
    const result = job.result;
    Object.defineProperty(job, 'result', { enumerable: true, configurable: true,
      get: () => { unrelatedReads++; return result; } });
  }
  expect(validateJevWorkspacePool(encoded)).toBeUndefined();
  expect(sourceReads).toBe(600); expect(unrelatedReads).toBe(0);
});

it.each([null, [], 4, {}, { jobs: 'future', proposals: 'future', receipts: 'future', profiles: 'future', prepared: 'future' },
  { jobs: [null, [], 4], proposals: [null, [], 4], receipts: [null, [], 4], prepared: [null, [], 4], profiles: { null: null, array: [], primitive: 4 } },
])('keeps literal future containers authoritative when no source reference targets them: %j', value => {
  const encoded = { codec: 'jev-source-vectors', version: 1, sources: [], vectors: [], references: [], state: value };
  expect(validateJevWorkspacePool(encoded)).toBeUndefined();
  expect(decodeJevWorkspace(encoded)).toEqual(value);
});
