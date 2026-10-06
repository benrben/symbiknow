import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { git, gitContent } from './version-git.js';
import { readSource, sourceFile } from './version-source.js';
import { commitIdentity, mergeEmail } from './version-identity.js';
import { hasRepository, serializeInitialization, unbornRepository, workingSource } from './version-initialization.js';
import { checkedBranch, checkedRevision, revisionDetails } from './version-reference.js';
import { abortFailedMerge } from './version-merge-recovery.js';

export class DocumentVersions {
  constructor(private readonly root: string) {}

  async init(content: string): Promise<void> {
    return serializeInitialization(this.root, () => this.initialize(content));
  }

  /** True when history can be read as it is: the repository exists and already records this saved source. */
  async matches(content: string): Promise<boolean> {
    if (!await hasRepository(this.root) || await unbornRepository(this.root)) return false;
    return await workingSource(this.root) === content && !await git(this.root, 'status', '--porcelain', '--', sourceFile);
  }

  private async initialize(content: string): Promise<void> {
    if (!await hasRepository(this.root)) {
      await this.bootstrap(content);
      return;
    }
    const current = await workingSource(this.root);
    const dirty = current !== content || Boolean(await git(this.root, 'status', '--porcelain', '--', sourceFile));
    if (!dirty) return;
    if (await unbornRepository(this.root)) await this.bootstrap(content);
    else await this.commit(content, 'Import filesystem edit', 'filesystem');
  }

  private async bootstrap(content: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await git(this.root, 'init', '-q');
    await git(this.root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await git(this.root, 'config', 'user.name', 'SymbiKnow');
    await git(this.root, 'config', 'user.email', 'symbiknow@local');
    await writeFile(path.join(this.root, sourceFile), content);
    await this.commit(content, 'Initial document');
  }

  /** Commit the file as `author` so history shows which person or agent made each revision. */
  async commit(content: string, message: string, author = 'SymbiKnow'): Promise<boolean> {
    await writeFile(path.join(this.root, sourceFile), content);
    await git(this.root, 'add', '--', sourceFile);
    if (!await git(this.root, 'diff', '--cached', '--name-only')) return false;
    const { name, email } = commitIdentity(author);
    await git(this.root, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message.slice(0, 180));
    return true;
  }

  /** An empty commit that records who removed the document. The last content stays in history for recovery. */
  async recordDeletion(message: string, author = 'SymbiKnow'): Promise<void> {
    const { name, email } = commitIdentity(author);
    await git(this.root, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message.slice(0, 180));
  }

  async status(options: { limit?: number; cursor?: number } = {}) {
    const current = await git(this.root, 'branch', '--show-current');
    const branches = (await git(this.root, 'branch', '--format=%(refname:short)')).split('\n').filter(Boolean);
    const limit = options.limit ?? 100;
    const cursor = options.cursor ?? 0;
    const lines = (await git(this.root, 'log', `--max-count=${limit}`, `--skip=${cursor}`,
      '--format=%H%x1f%P%x1f%s%x1f%aI%x1f%an')).split('\n').filter(Boolean);
    const commits = lines.map(revisionDetails);
    return { current, branches, commits };
  }

  private async revisionDetails(target: string) {
    return revisionDetails(await git(this.root, 'show', '-s', '--format=%H%x1f%P%x1f%s%x1f%aI%x1f%an', target));
  }

  /** Read the resulting source without changing the checked-out branch or document. */
  async preview(kind: 'switch' | 'merge' | 'restore', target: string) {
    const before = await this.content();
    await this.requireClean();
    if (kind === 'restore') {
      checkedRevision(target);
      await this.requireRevision(target);
      return { before, after: await gitContent(this.root, target), scope: 'This document only', revision: await this.revisionDetails(target) };
    }
    await this.requireBranch(target);
    if (kind === 'switch') {
      return { before, after: await gitContent(this.root, target), scope: 'This document only', revision: await this.revisionDetails(target) };
    }
    if (target === (await this.status()).current) throw new ApiError(400, 'Choose another branch to merge');
    let tree: string;
    try { tree = (await git(this.root, 'merge-tree', '--write-tree', 'HEAD', target)).split('\n')[0]; }
    catch { throw new ApiError(409, 'Merge conflict in this document. No changes were applied.'); }
    return { before, after: await gitContent(this.root, tree), scope: 'This document only', revision: await this.revisionDetails(target) };
  }

  private async requireBranch(name: string): Promise<void> {
    checkedBranch(name);
    const branches = (await this.status()).branches;
    if (!branches.includes(name)) throw new ApiError(404, 'Branch not found');
  }

  private async requireClean(): Promise<void> {
    if (await git(this.root, 'status', '--porcelain', '--', sourceFile)) {
      throw new ApiError(409, 'This document has uncommitted changes. Save them before switching branches.');
    }
  }

  private async requireRevision(revision: string): Promise<void> {
    try { await git(this.root, 'cat-file', '-e', `${revision}^{commit}`); }
    catch { throw new ApiError(404, 'Revision not found'); }
  }

  async createBranch(name: string) {
    checkedBranch(name);
    try { await git(this.root, 'branch', name); }
    // The native Git adapter always rejects with an Error.
    catch (error) { throw new ApiError(409, (error as Error).message); }
    return this.status();
  }

  /** Read a named branch without changing HEAD or the visible source file. */
  async branchContent(name: string): Promise<{ content: string; revision: string }> {
    await this.requireBranch(name);
    return { content: await gitContent(this.root, name), revision: await git(this.root, 'rev-parse', name) };
  }

  /** Commit on a detached temporary worktree, then move only the named branch ref. */
  async commitBranch(name: string, content: string, message: string, author = 'SymbiKnow') {
    await this.requireBranch(name);
    if (name === (await this.status()).current) throw new ApiError(409, 'Use the visible document edit for the current branch');
    const previous = await git(this.root, 'rev-parse', name);
    const worktree = await mkdtemp(path.join(path.dirname(this.root), 'branch-edit-'));
    try {
      await git(this.root, 'worktree', 'add', '--detach', worktree, previous);
      await writeFile(path.join(worktree, sourceFile), content);
      await git(worktree, 'add', '--', sourceFile);
      if (!await git(worktree, 'diff', '--cached', '--name-only')) return this.branchContent(name);
      const { name: authorName, email } = commitIdentity(author);
      await git(worktree, '-c', `user.name=${authorName}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message.slice(0, 180));
      const revision = await git(worktree, 'rev-parse', 'HEAD');
      await git(this.root, 'update-ref', `refs/heads/${name}`, revision, previous);
      return { content, revision };
    } finally {
      await git(this.root, 'worktree', 'remove', '--force', worktree).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true });
    }
  }

  async deleteBranch(name: string) {
    await this.requireBranch(name);
    if (name === 'main' || name === (await this.status()).current) throw new ApiError(409, 'The current or protected branch cannot be deleted');
    try { await git(this.root, 'branch', '-d', '--', name); }
    catch { throw new ApiError(409, 'This branch has unmerged work and cannot be deleted'); }
    return this.status();
  }

  async switchBranch(name: string) {
    await this.requireBranch(name);
    await this.requireClean();
    await git(this.root, 'switch', '-q', name);
    return { status: await this.status(), content: await this.content() };
  }

  async mergeBranch(name: string, author = 'SymbiKnow') {
    await this.requireBranch(name);
    await this.requireClean();
    if (name === (await this.status()).current) throw new ApiError(400, 'Choose another branch to merge');
    const before = await this.content();
    const email = mergeEmail(author);
    try { await git(this.root, '-c', `user.name=${author}`, '-c', `user.email=${email}`, 'merge', '--no-edit', name); }
    catch {
      await abortFailedMerge(this.root, before);
      throw new ApiError(409, 'Merge conflict in this document. No changes were applied.');
    }
    return { status: await this.status(), content: await this.content() };
  }

  async restoreRevision(revision: string, author = 'SymbiKnow') {
    checkedRevision(revision);
    await this.requireClean();
    await this.requireRevision(revision);
    await git(this.root, 'restore', '--source', revision, '--staged', '--worktree', '--', sourceFile);
    const content = await this.content();
    await this.commit(content, `Restore revision ${revision.slice(0, 12)}`, author);
    return { status: await this.status(), content };
  }

  async content(): Promise<string> { return readSource(this.root); }
}
