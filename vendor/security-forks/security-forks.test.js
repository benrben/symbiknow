import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('local security forks', () => {
  it('bounds numeric precision in sprintf-js while preserving ordinary formatting', () => {
    const { sprintf } = require('./sprintf-js-1.1');
    expect(sprintf('%.2f', 1.234)).toBe('1.23');
    for (const format of ['%.999f', '%.999e', '%.999g', '%.0g']) {
      const result = sprintf(format, 1.234);
      expect(typeof result).toBe('string');
      expect(result.length).toBeLessThan(200);
    }
  });

  it('treats deeply nested brace patterns as literals before recursive AST walks', () => {
    const braces = require('./braces');
    expect(braces('{a,b}')).toEqual(['(a|b)']);
    expect(braces('{a,b}', { expand: true })).toEqual(['a', 'b']);
    const deeplyNested = '{a,'.repeat(200) + 'z' + '}'.repeat(200);
    expect(braces(deeplyNested)).toEqual([deeplyNested]);
    expect(braces(deeplyNested, { expand: true })).toEqual([deeplyNested]);
    expect(braces.stringify(deeplyNested)).toBe(deeplyNested);
  });

  it('resolves gray-matter, micromatch, and roarr through patched local versions', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    for (const [name, version] of [['argparse', '1.0.11'], ['braces', '3.0.4'], ['sprintf-js', '1.1.4']]) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry.version).toBe(version);
      expect(entry.resolved).toMatch(/^file:vendor\/security-forks\//);
    }
    expect(Object.keys(lock.packages).filter(path => /node_modules\/(?:braces|sprintf-js)$/.test(path)))
      .toEqual(['node_modules/braces', 'node_modules/sprintf-js']);
    expect(require('gray-matter')('---\ntitle: Note\n---\nBody').data.title).toBe('Note');
    expect(require('micromatch')(['note.md'], ['*.md'])).toEqual(['note.md']);
    expect(require('roarr')).toBeDefined();
  });
});
