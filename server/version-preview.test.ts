import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DocumentVersions } from './version-control.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('previews branch switch, merge, and restore without changing the active document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbiknow-version-preview-'));
  roots.push(root);
  const versions = new DocumentVersions(root);
  await versions.init('# First\n');
  const firstRevision = (await versions.status()).commits[0].id;
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('# Revised\n', 'Revise', 'Tester');
  await versions.switchBranch('main');

  const switchPreview = await versions.preview('switch', 'draft');
  const mergePreview = await versions.preview('merge', 'draft');
  const restorePreview = await versions.preview('restore', firstRevision);
  expect(switchPreview).toMatchObject({ before: '# First\n', after: '# Revised\n', scope: 'This document only' });
  expect(mergePreview).toMatchObject({ before: '# First\n', after: '# Revised\n' });
  expect(restorePreview).toMatchObject({ before: '# First\n', after: '# First\n', revision: { id: firstRevision, author: 'SymbiKnow' } });
  expect((await versions.status()).current).toBe('main');
  expect(await versions.content()).toBe('# First\n');
});
