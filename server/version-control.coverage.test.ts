import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentVersions } from './version-control.js';

const execute = promisify(execFile);
let directory: string;
let versions: DocumentVersions;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-package-versions-'));
  versions = new DocumentVersions(path.join(directory, 'repository'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
function shellPath(file: string): string { return `'${file.replaceAll("'", "'\\''")}'`; }

it('does not report a match before the document repository exists', async () => {
  expect(await versions.matches('# Source\n')).toBe(false);
});

it('refuses to roll back a website transaction whose visible branch is missing from the checkpoint', async () => {
  await versions.init('# Visible\n');
  const checkpoint = await versions.packageCheckpoint();
  await versions.createBranch('agent/later');
  await versions.switchBranch('agent/later');
  await expect(versions.restorePackageCheckpoint(checkpoint))
    .rejects.toMatchObject({ status: 409, message: 'The website transaction branch disappeared during rollback' });
  expect((await versions.status()).current).toBe('agent/later');
});

it('previews a merge without a source package and refuses a conflicting package merge', async () => {
  await versions.init('# Visible\n');
  await versions.createBranch('agent/source');
  await versions.commitBranch('agent/source', '# Branch source\n', 'Branch source');
  expect(await versions.previewPackage('merge', 'agent/source')).toBeUndefined();
  await versions.createBranch('agent/assets');
  await versions.commitPackage('main', '{"files":["main"]}', 'Main assets');
  await versions.commitPackage('agent/assets', '{"files":["branch"]}', 'Branch assets');
  const before = await versions.status();
  await expect(versions.previewPackage('merge', 'agent/assets'))
    .rejects.toMatchObject({ status: 409, message: 'Merge conflict in the website source package. No changes were applied.' });
  expect(await versions.status()).toEqual(before);
});

it('keeps a committed private package when Git worktree cleanup fails and removes its temporary files', async () => {
  await versions.init('# Visible\n');
  await versions.createBranch('agent/site');
  const realGit = (await execute('which', ['git'])).stdout.trim();
  const bin = path.join(directory, 'bin');
  const marker = path.join(directory, 'cleanup-attempted');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ]; then\n  : > ${shellPath(marker)}\n  exit 1\nfi\nexec ${shellPath(realGit)} "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  const revision = await versions.commitPackage('agent/site', '{"files":["private"]}', 'Private assets', 'Agent');
  expect(await readFile(marker, 'utf8')).toBe('');
  expect((await versions.branchContent('agent/site')).revision).toBe(revision);
  expect(await versions.packageContent(revision)).toBe('{"files":["private"]}');
  expect((await versions.status()).current).toBe('main');
  expect((await readdir(directory)).filter(name => name.startsWith('package-edit-'))).toEqual([]);
});
