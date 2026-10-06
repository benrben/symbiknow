import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const sourceFile = 'source.md';

export async function readSource(root: string): Promise<string> {
  return readFile(path.join(root, sourceFile), 'utf8');
}
