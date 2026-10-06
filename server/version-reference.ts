import { ApiError } from './errors.js';

const branchName = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const revisionId = /^[0-9a-f]{7,40}$/i;

export function checkedBranch(value: string): string {
  if (!branchName.test(value) || value.includes('..') || value.includes('//') || value.endsWith('.lock')) {
    throw new ApiError(400, 'Invalid branch name');
  }
  return value;
}

export function checkedRevision(value: string): void {
  if (!revisionId.test(value)) throw new ApiError(400, 'Invalid revision ID');
}

export function revisionDetails(line: string) {
  const [id, parents, message, createdAt, author] = line.split('\x1f');
  return { id, parents: parents ? parents.split(' ') : [], message, createdAt: new Date(createdAt).toISOString(), author };
}
