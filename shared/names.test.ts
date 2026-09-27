import { describe, expect, it } from 'vitest';
import { fileNameForTitle } from './names';

describe('fileNameForTitle', () => {
  it('produces a Markdown file name from a document title', () => {
    expect(fileNameForTitle('  Meeting Notes!  ')).toBe('meeting-notes.md');
  });

  it('rejects a title without a usable filename', () => {
    expect(() => fileNameForTitle(' --- ')).toThrow('letter or number');
  });
});
