import { expect, it } from 'vitest';
import type { JevInputDocument } from './context.js';
import { documentRoles, roleShortlist } from './role-catalog.js';

function document(title: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'one',
    incarnation: 'one', sourceGeneration: 1, metadataRevision: 1, contentHash: 'hash' },
  block: { id: 'one', title, content, file: 'one.md', kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] } };
}

it('provides stable distinct roles with definitions, aliases, and examples', () => {
  expect(documentRoles).toHaveLength(18);
  expect(new Set(documentRoles.map(role => role.id)).size).toBe(documentRoles.length);
  expect(documentRoles.every(role => role.definition && role.aliases.length && role.examples.length)).toBe(true);
});

it('shortlists a source-relevant operational role and preserves insufficient-evidence choices', () => {
  const roles = roleShortlist(document('Rollback runbook', 'When a release fails, follow the rollback steps.'));
  expect(Object.keys(roles)).toHaveLength(12);
  expect(roles).toHaveProperty('runbook');
  expect(roles).toHaveProperty('none');
  expect(roles).toHaveProperty('unknown');
  expect(roles).not.toHaveProperty('changelog');
});
