import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['server', 'shared'].map(dir => path.join(repoRoot, dir));

/** A Noul question's optional criteria keys must be true/false, never yes/no. Catches the bug at the text level,
 * without needing to parse every question literal into an AST. */
const yesNoNoulCriteria = /type:\s*'noul'[\s\S]{0,400}?criteria:\s*\{[^}]{0,300}?\b(?:yes|no)\s*:/;

function tsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) { files.push(...tsFiles(full)); continue; }
    if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) files.push(full);
  }
  return files;
}

describe('Jev Noul criteria contract', () => {
  it('never uses yes/no keys for a Noul question\'s criteria (must be true/false)', () => {
    const offenders = roots.flatMap(tsFiles).flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return yesNoNoulCriteria.test(text) ? [path.relative(repoRoot, file)] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('the detector actually matches the yes/no pattern it exists to catch', () => {
    const offending = `questions.stale = { type: 'noul', instructions: 'x',\n  criteria: { yes: 'A', no: 'B' } };`;
    expect(yesNoNoulCriteria.test(offending)).toBe(true);
    const fixed = `questions.stale = { type: 'noul', instructions: 'x',\n  criteria: { true: 'A', false: 'B' } };`;
    expect(yesNoNoulCriteria.test(fixed)).toBe(false);
  });
});
