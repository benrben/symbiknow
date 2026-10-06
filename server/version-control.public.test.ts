import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentVersions } from './version-control.js';

const execute = promisify(execFile);
let directory: string;
let repository: string;
let versions: DocumentVersions;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'allteam-native-versions-'));
  repository = path.join(directory, 'repository');
  versions = new DocumentVersions(repository);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function nativeGit(...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: repository, maxBuffer: 16_000_000 })).stdout.trim();
}
function shellPath(file: string): string { return `'${file.replaceAll("'", "'\\''")}'`; }

it('keeps the active branch when importing a filesystem edit fails and imports that edit when the native index lock is removed', async () => {
  await versions.init('# Initial\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  const before = await versions.status();
  const lock = path.join(repository, '.git', 'index.lock');
  await writeFile(lock, 'blocked');
  await expect(versions.init('# Imported draft\n')).rejects.toThrow('index.lock');
  expect(await versions.status()).toEqual(before);
  await rm(lock);
  await new DocumentVersions(repository).init('# Imported draft\n');
  expect((await versions.status()).commits[0]).toMatchObject({ author: 'filesystem', message: 'Import filesystem edit' });
  expect((await versions.status()).current).toBe('draft');
  expect(await versions.content()).toBe('# Imported draft\n');
});

it('edits a named branch without switching or replacing the visible source and deletes it only after merge', async () => {
  await versions.init('# Visible\n');
  await versions.createBranch('agent/draft');
  const before = await versions.status();
  const edited = await versions.commitBranch('agent/draft', '# Branch only\n', 'Private edit', 'Agent');
  expect(edited.content).toBe('# Branch only\n');
  expect((await versions.branchContent('agent/draft')).revision).toBe(edited.revision);
  expect(await versions.content()).toBe('# Visible\n');
  expect((await versions.status()).current).toBe(before.current);
  expect((await versions.status()).commits).toEqual(before.commits);
  await expect(versions.deleteBranch('agent/draft')).rejects.toMatchObject({ status: 409 });
  await versions.mergeBranch('agent/draft');
  expect(await versions.content()).toBe('# Branch only\n');
  expect((await versions.deleteBranch('agent/draft')).branches).toEqual(['main']);
});

it('keeps a committed private branch when Git worktree cleanup fails and removes its temporary files', async () => {
  await versions.init('# Visible\n');
  await versions.createBranch('agent/draft');
  const realGit = (await execute('which', ['git'])).stdout.trim();
  const bin = path.join(directory, 'bin');
  const marker = path.join(directory, 'cleanup-attempted');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ]; then\n  : > ${shellPath(marker)}\n  exit 1\nfi\nexec ${shellPath(realGit)} "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  const saved = await versions.commitBranch('agent/draft', '# Private edit\n', 'Private edit', 'Agent');
  expect(await readFile(marker, 'utf8')).toBe('');
  expect((await versions.branchContent('agent/draft')).revision).toBe(saved.revision);
  expect(await versions.content()).toBe('# Visible\n');
  expect((await readdir(directory)).filter(name => name.startsWith('branch-edit-'))).toEqual([]);
});

it('restores a missing working source without resetting the active branch or replacing its committed history', async () => {
  await versions.init('# Initial\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('# Draft\n', 'Draft edit', 'Writer');
  const before = await versions.status();
  await rm(path.join(repository, 'source.md'));
  await new DocumentVersions(repository).init('# Draft\n');
  expect(await versions.status()).toEqual(before);
  expect(await versions.content()).toBe('# Draft\n');
});

it('serializes initialization across instances while a genuine initial Git commit is still running', async () => {
  await mkdir(repository);
  await nativeGit('init', '-q', '--initial-branch=main');
  const marker = path.join(directory, 'commit-started');
  const finished = path.join(directory, 'hook-finished');
  const hook = path.join(repository, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, `#!/bin/sh\nprintf started > ${shellPath(marker)}\nsleep 0.2\nprintf finished > ${shellPath(finished)}\n`, { mode: 0o755 });
  const first = versions.init('# Initial\n');
  await expect.poll(() => readFile(marker, 'utf8'), { interval: 10 }).toBe('started');
  const second = new DocumentVersions(repository).init('# Initial\n').then(async () => {
    expect(await readFile(finished, 'utf8')).toBe('finished');
  });
  const initialized = await Promise.allSettled([first, second]);
  expect(initialized.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((await versions.status()).commits).toHaveLength(1);
  expect(await nativeGit('status', '--porcelain')).toBe('');
});

async function divergentDraft() {
  await versions.init('First\n\nMiddle\n\nLast\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('Draft first\n\nMiddle\n\nLast\n', 'Draft first line', 'Writer');
  await versions.switchBranch('main');
  await versions.commit('First\n\nMiddle\n\nMain last\n', 'Main last line', 'Reviewer');
}

it('reports incomplete recovery when a native merge hook blocks Git abort and can merge after the repository is repaired', async () => {
  await divergentDraft();
  const before = await versions.content();
  const hook = path.join(repository, '.git', 'hooks', 'pre-merge-commit');
  const lock = path.join(repository, '.git', 'index.lock');
  await writeFile(hook, `#!/bin/sh\n: > ${shellPath(lock)}\nexit 1\n`, { mode: 0o755 });
  await expect(versions.mergeBranch('draft', 'Merger')).rejects.toMatchObject({ status: 409,
    message: expect.stringContaining('could not be rolled back') });
  expect(await versions.content()).not.toBe(before);
  await expect(access(path.join(repository, '.git', 'MERGE_HEAD'))).resolves.toBeUndefined();
  await rm(lock);
  await rm(hook);
  await nativeGit('merge', '--abort');
  expect(await versions.content()).toBe(before);
  const merged = await new DocumentVersions(repository).mergeBranch('draft', 'Merger');
  expect(merged.content).toBe('Draft first\n\nMiddle\n\nMain last\n');
  expect(merged.status.commits[0]).toMatchObject({ author: 'Merger', parents: expect.any(Array) });
  expect(merged.status.commits[0].parents).toHaveLength(2);
});

it('initializes, imports, commits, sanitizes attribution and records deletions with the native return formats', async () => {
  await versions.init('# Initial\n\n');
  const initial = await versions.status();
  expect(initial).toMatchObject({ current: 'main', branches: ['main'], commits: [{ author: 'SymbiKnow', parents: [], message: 'Initial document' }] });
  await versions.init('# Initial\n\n');
  expect(await versions.status()).toEqual(initial);
  expect(await versions.commit('# Initial\n\n', 'Unchanged')).toBe(false);
  expect(await versions.commit('# Revised\n', 'x'.repeat(200), '<>\n')).toBe(true);
  expect((await versions.status()).commits[0]).toMatchObject({ author: 'SymbiKnow', message: 'x'.repeat(180), parents: [initial.commits[0].id] });
  await versions.recordDeletion('Delete default');
  await versions.recordDeletion('d'.repeat(200), '<>\n');
  expect((await versions.status()).commits.slice(0, 2)).toMatchObject([
    { author: 'SymbiKnow', message: 'd'.repeat(180) }, { author: 'SymbiKnow', message: 'Delete default' },
  ]);
  expect(await versions.content()).toBe('# Revised\n');
});

it('reinitializes deleted repository metadata from current content and surfaces obstructed or corrupt native repositories', async () => {
  await versions.init('# Initial\n');
  await rm(path.join(repository, '.git'), { recursive: true });
  await versions.init('# Recovered\n');
  expect((await versions.status()).commits).toHaveLength(1);
  expect(await versions.content()).toBe('# Recovered\n');
  await rm(path.join(repository, '.git'), { recursive: true });
  await writeFile(path.join(repository, '.git'), 'corrupt Git metadata');
  await expect(versions.status()).rejects.toThrow('invalid gitfile format');
  await expect(versions.init('# Recovered\n')).rejects.toThrow('invalid gitfile format');
  await expect(versions.init('# Different input\n')).rejects.toThrow('invalid gitfile format');
  await rm(path.join(repository, '.git'));
  await versions.init('# Recovered\n');
  expect((await versions.status()).commits).toHaveLength(1);
  await rm(path.join(repository, 'source.md'));
  await mkdir(path.join(repository, 'source.md'));
  await expect(versions.init('# Recovered\n')).rejects.toMatchObject({ code: 'EISDIR' });
  await rm(path.join(repository, 'source.md'), { recursive: true });
  await versions.init('# Recovered\n');
  expect(await versions.content()).toBe('# Recovered\n');
  await rm(repository, { recursive: true });
  await writeFile(repository, 'obstruction');
  await expect(versions.status()).rejects.toThrow();
  await expect(versions.init('# Blocked\n')).rejects.toBeInstanceOf(Error);
  expect(await readFile(repository, 'utf8')).toBe('obstruction');
  await rm(repository);
  await versions.init('# Retried\n');
  expect(await versions.content()).toBe('# Retried\n');
});

it.each(['../outside', 'bad..name', 'bad//name', 'bad.lock', '-option', 'a'.repeat(65)])('rejects invalid branch %s before native mutation', async name => {
  await versions.init('# Initial\n');
  const before = await versions.status();
  await expect(versions.createBranch(name)).rejects.toMatchObject({ status: 400, message: 'Invalid branch name' });
  expect(await versions.status()).toEqual(before);
});

it('preserves duplicate, missing and same-branch failures and refuses dirty branch operations in their original validation order', async () => {
  await versions.init('# Initial\n');
  const original = (await versions.status()).commits[0].id;
  await versions.createBranch('draft');
  await expect(versions.createBranch('draft')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already exists') });
  await expect(versions.switchBranch('missing')).rejects.toMatchObject({ status: 404, message: 'Branch not found' });
  await expect(versions.preview('merge', 'main')).rejects.toMatchObject({ status: 400 });
  await expect(versions.mergeBranch('main')).rejects.toMatchObject({ status: 400 });
  await expect(versions.preview('restore', 'invalid')).rejects.toMatchObject({ status: 400 });
  await expect(versions.restoreRevision('invalid')).rejects.toMatchObject({ status: 400 });
  await expect(versions.preview('restore', '0000000000000000000000000000000000000000')).rejects.toMatchObject({ status: 404 });
  await expect(versions.restoreRevision('0000000000000000000000000000000000000000')).rejects.toMatchObject({ status: 404 });
  await writeFile(path.join(repository, 'source.md'), '# Uncommitted draft\n');
  await expect(versions.preview('restore', 'invalid')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('uncommitted changes') });
  await expect(versions.restoreRevision('invalid')).rejects.toMatchObject({ status: 400 });
  await expect(versions.switchBranch('draft')).rejects.toMatchObject({ status: 409 });
  await expect(versions.mergeBranch('draft')).rejects.toMatchObject({ status: 409 });
  await expect(versions.restoreRevision(original)).rejects.toMatchObject({ status: 409 });
  expect(await versions.content()).toBe('# Uncommitted draft\n');
  await versions.commit('# Uncommitted draft\n', 'Save draft');
  expect((await versions.switchBranch('draft')).content).toBe('# Initial\n');
});

it('previews a real two-parent merge without writing it, merges with the default author and restores the original revision', async () => {
  await divergentDraft();
  const initial = (await versions.status()).commits.at(-1)!.id;
  const before = await versions.status();
  const content = await versions.content();
  const preview = await versions.preview('merge', 'draft');
  expect(preview).toMatchObject({ before: content, after: 'Draft first\n\nMiddle\n\nMain last\n', scope: 'This document only', revision: { author: 'Writer' } });
  expect(await versions.status()).toEqual(before);
  expect(await versions.content()).toBe(content);
  const merged = await versions.mergeBranch('draft');
  expect(merged.status.commits[0]).toMatchObject({ author: 'SymbiKnow', parents: expect.any(Array) });
  expect(merged.status.commits[0].parents).toHaveLength(2);
  const restored = await versions.restoreRevision(initial);
  expect(restored.content).toBe('First\n\nMiddle\n\nLast\n');
  expect(restored.status.commits[0]).toMatchObject({ author: 'SymbiKnow', message: `Restore revision ${initial.slice(0, 12)}` });
});

it('returns the current source after a fast-forward merge with an explicitly empty author', async () => {
  await versions.init('# Initial\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('# Draft\n', 'Draft edit', 'Writer');
  await versions.switchBranch('main');
  expect((await versions.mergeBranch('draft', '')).content).toBe('# Draft\n');
});

it('rejects previews of historical revisions without source.md through the actual Git show failure', async () => {
  await versions.init('# Initial\n');
  const initial = (await versions.status()).commits[0].id;
  await nativeGit('rm', 'source.md');
  await nativeGit('-c', 'user.name=Native', '-c', 'user.email=native@example.com', 'commit', '-q', '-m', 'Remove historical source');
  const deleted = (await versions.status()).commits[0].id;
  await versions.createBranch('without-source');
  await versions.restoreRevision(initial);
  await expect(versions.preview('restore', deleted)).rejects.toThrow('not in');
  await expect(versions.preview('switch', 'without-source')).rejects.toThrow('not in');
  expect(await versions.content()).toBe('# Initial\n');
});

it('preserves native stdout-buffer failure messages when a saved source exceeds the preview read bound', async () => {
  const large = '# Large source\n' + 'x'.repeat(8_100_000);
  await versions.init(large);
  const revision = (await versions.status()).commits[0].id;
  await expect(versions.preview('restore', revision)).rejects.toThrow('maxBuffer');
  expect(await versions.content()).toBe(large);
});

it('preserves the original source after a genuine merge conflict in both preview and application', async () => {
  await versions.init('# Initial\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('# Draft\n', 'Draft edit');
  await versions.switchBranch('main');
  await versions.commit('# Main\n', 'Main edit');
  const before = await versions.status();
  const failure = { status: 409, message: 'Merge conflict in this document. No changes were applied.' };
  await expect(versions.preview('merge', 'draft')).rejects.toMatchObject(failure);
  await expect(versions.mergeBranch('draft')).rejects.toMatchObject(failure);
  expect(await versions.status()).toEqual(before);
  expect(await versions.content()).toBe('# Main\n');
  expect(await nativeGit('status', '--porcelain')).toBe('');
});

it('preserves the ordinary conflict response when an index lock stops a merge before any merge state exists', async () => {
  await versions.init('# Initial\n');
  await versions.createBranch('draft');
  await versions.switchBranch('draft');
  await versions.commit('# Draft\n', 'Draft edit');
  await versions.switchBranch('main');
  const lock = path.join(repository, '.git', 'index.lock');
  await writeFile(lock, 'blocked');
  await expect(versions.mergeBranch('draft')).rejects.toMatchObject({ status: 409,
    message: 'Merge conflict in this document. No changes were applied.' });
  expect(await versions.content()).toBe('# Initial\n');
  await rm(lock);
  expect((await versions.mergeBranch('draft')).content).toBe('# Draft\n');
});

it('reports changed working content even when a failing native merge hook removes the merge marker', async () => {
  await divergentDraft();
  const before = await versions.content();
  const hook = path.join(repository, '.git', 'hooks', 'pre-merge-commit');
  const lock = path.join(repository, '.git', 'index.lock');
  await writeFile(hook, `#!/bin/sh\n: > ${shellPath(lock)}\nrm ${shellPath(path.join(repository, '.git', 'MERGE_HEAD'))}\nexit 1\n`, { mode: 0o755 });
  await expect(versions.mergeBranch('draft')).rejects.toMatchObject({ status: 409,
    message: expect.stringContaining('could not be rolled back') });
  expect(await versions.content()).not.toBe(before);
  await rm(lock);
  await rm(hook);
  await nativeGit('reset', '--hard', 'HEAD');
  expect(await versions.content()).toBe(before);
  expect((await versions.mergeBranch('draft')).content).toBe('Draft first\n\nMiddle\n\nMain last\n');
});

it('surfaces repository obstructions during native abort instead of silently claiming recovery', async () => {
  await divergentDraft();
  const before = await versions.content();
  const hook = path.join(repository, '.git', 'hooks', 'pre-merge-commit');
  const metadata = path.join(repository, '.git');
  await writeFile(hook, `#!/bin/sh\nmv ${shellPath(metadata)} ${shellPath(metadata + '.backup')}\nprintf blocked > ${shellPath(metadata)}\nexit 1\n`, { mode: 0o755 });
  await expect(versions.mergeBranch('draft')).rejects.toMatchObject({ code: 'ENOTDIR' });
  await rm(metadata);
  await rename(metadata + '.backup', metadata);
  await rm(hook);
  await nativeGit('reset', '--hard', 'HEAD');
  expect(await versions.content()).toBe(before);
  expect((await versions.mergeBranch('draft')).content).toBe('Draft first\n\nMiddle\n\nMain last\n');
});

it('drains failed initialization attempts and can bootstrap the same native repository after repair', async () => {
  await mkdir(repository);
  await nativeGit('init', '-q', '--initial-branch=main');
  const lock = path.join(repository, '.git', 'index.lock');
  await writeFile(lock, 'blocked');
  const attempts = await Promise.allSettled([versions.init('# Initial\n'), new DocumentVersions(repository).init('# Initial\n')]);
  expect(attempts.map(result => result.status)).toEqual(['rejected', 'rejected']);
  await rm(lock);
  await new DocumentVersions(repository).init('# Initial\n');
  expect((await versions.status()).commits).toMatchObject([{ message: 'Initial document', author: 'SymbiKnow' }]);
  expect(await nativeGit('status', '--porcelain')).toBe('');
});
