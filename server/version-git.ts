import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceFile } from './version-source.js';

const exec = promisify(execFile);

async function output(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 8_000_000 });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

export async function git(root: string, ...args: string[]): Promise<string> {
  return (await output(root, args)).trim();
}

/** Preserve the document's whitespace when reading a Git tree or revision. */
export async function gitContent(root: string, revision: string): Promise<string> {
  return output(root, ['show', `${revision}:${sourceFile}`]);
}
