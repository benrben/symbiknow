import type { SymbiIndexDocument } from '../shared/symbi-contract.js';

/** Offline source fixtures; outcomes also describe intended organization judgments. */
export const symbiFixtureDocuments: SymbiIndexDocument[] = [
  {
    canvasId: 'operations', blockId: 'rollback', title: 'Release rollback runbook',
    content: 'If deployment health checks fail, stop rollout and restore the previous release. Verify service health before closing the incident.',
    contentHash: 'fixture-rollback-v1', metadataRevision: 1, tags: ['release', 'recovery'],
    group: 'Operations', purpose: 'Restore service after a bad release', links: ['release-plan'],
  },
  {
    canvasId: 'operations', blockId: 'release-plan', title: 'Release plan',
    content: 'Deploy the candidate to staging. Check health. Promote to production only after approval.',
    contentHash: 'fixture-release-plan-v1', metadataRevision: 1, tags: ['release'],
    group: 'Operations', purpose: 'Plan production deployment', links: ['rollback'],
  },
  {
    canvasId: 'operations', blockId: 'rollback-copy', title: 'Rollback procedure copy',
    content: 'If deployment health checks fail, stop rollout and restore the previous release. Verify service health before closing the incident.',
    contentHash: 'fixture-rollback-copy-v1', metadataRevision: 1,
  },
  {
    canvasId: 'people', blockId: 'onboarding', title: 'Employee onboarding checklist',
    content: 'Create an employee account, arrange an orientation meeting, and share the benefits guide.',
    contentHash: 'fixture-onboarding-v1', metadataRevision: 1, tags: ['people'],
    group: 'Human resources', purpose: 'Help new employees start work',
  },
  {
    canvasId: 'operations', blockId: 'ambiguous', title: 'Launch meeting notes',
    content: 'The team discussed launch timing, staffing, release readiness, and unresolved customer communication.',
    contentHash: 'fixture-ambiguous-v1', metadataRevision: 1,
  },
];

export const symbiFixtureExpectations = {
  retrieval: [
    { query: 'How can we recover from a failed deployment?', topBlockId: 'rollback' },
    { query: 'new employee setup', topBlockId: 'onboarding' },
  ],
  group: [
    { blockId: 'rollback', expectedGroup: 'Operations' },
    { blockId: 'ambiguous', expectedGroup: null },
  ],
  links: [
    { source: 'release-plan', target: 'rollback', relationship: 'related' },
    { source: 'onboarding', target: 'rollback', relationship: null },
  ],
  duplicates: [
    { left: 'rollback', right: 'rollback-copy', duplicate: true },
    { left: 'rollback', right: 'release-plan', duplicate: false },
  ],
} as const;
