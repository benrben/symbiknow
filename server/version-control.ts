import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';

const exec = promisify(execFile);
const sourceFile = 'source.md';
const branchName = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const revisionId = /^[0-9a-f]{7,40}$/i;

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 8_000_000 });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

function checkedBranch(value: string): string {
  if (!branchName.test(value) || value.includes('..') || value.includes('//') || value.endsWith('.lock')) {
    throw new ApiError(400, 'Invalid branch name');
  }
  return value;
}

export class DocumentVersions {
  constructor(private readonly root: string) {}

  async init(content: string): Promise<void> {
    try {
      await access(path.join(this.root, '.git'));
      if (await this.content() !== content) await this.commit(content, 'Import filesystem edit', 'filesystem');
      return;
    }
    catch { await mkdir(this.root, { recursive: true }); }
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
    const name = author.replace(/[<>\n]/g, '').slice(0, 48) || 'SymbiKnow';
    const email = `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'symbiknow'}@symbiknow.local`;
    await git(this.root, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message.slice(0, 180));
    return true;
  }

  /** An empty commit that records who removed the document. The last content stays in history for recovery. */
  async recordDeletion(message: string, author = 'SymbiKnow'): Promise<void> {
    const name = author.replace(/[<>\n]/g, '').slice(0, 48) || 'SymbiKnow';
    const email = `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'symbiknow'}@symbiknow.local`;
    await git(this.root, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message.slice(0, 180));
  }

  async status() {
    const current = await git(this.root, 'branch', '--show-current');
    const branches = (await git(this.root, 'branch', '--format=%(refname:short)')).split('\n').filter(Boolean);
    const lines = (await git(this.root, 'log', '-100', '--format=%H%x1f%P%x1f%s%x1f%aI%x1f%an')).split('\n').filter(Boolean);
    const commits = lines.map(line => {
      const [id, parents, message, createdAt, author] = line.split('\x1f');
      return { id, parents: parents ? parents.split(' ') : [], message, createdAt, author };
    });
    return { current, branches, commits };
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

  async createBranch(name: string) {
    checkedBranch(name);
    try { await git(this.root, 'branch', name); }
    catch (error) { throw new ApiError(409, error instanceof Error ? error.message : 'Could not create branch'); }
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
    const email = `${author.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'symbiknow'}@symbiknow.local`;
    try { await git(this.root, '-c', `user.name=${author}`, '-c', `user.email=${email}`, 'merge', '--no-edit', name); }
    catch {
      await git(this.root, 'merge', '--abort').catch(() => undefined);
      throw new ApiError(409, 'Merge conflict in this document. No changes were applied.');
    }
    return { status: await this.status(), content: await this.content() };
  }

  async restoreRevision(revision: string, author = 'SymbiKnow') {
    if (!revisionId.test(revision)) throw new ApiError(400, 'Invalid revision ID');
    await this.requireClean();
    try { await git(this.root, 'cat-file', '-e', `${revision}^{commit}`); }
    catch { throw new ApiError(404, 'Revision not found'); }
    await git(this.root, 'restore', '--source', revision, '--staged', '--worktree', '--', sourceFile);
    const content = await this.content();
    await this.commit(content, `Restore revision ${revision.slice(0, 12)}`, author);
    return { status: await this.status(), content };
  }

  async content(): Promise<string> { return readFile(path.join(this.root, sourceFile), 'utf8'); }
}
