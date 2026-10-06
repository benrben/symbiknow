import { describe, expect, it } from 'vitest';
import { fileNameForTitle, plainGroupName } from './names';

describe('fileNameForTitle', () => {
  it('produces a Markdown file name from a document title', () => {
    expect(fileNameForTitle('  Meeting Notes!  ')).toBe('meeting-notes.md');
  });

  it('rejects a title without a usable filename', () => {
    expect(() => fileNameForTitle(' --- ')).toThrow('letter or number');
  });
});

describe('plainGroupName', () => {
  it.each([
    ['**Group:** Documents', 'Documents'],
    ['__Group:__ Files', 'Files'],
    ['`upload_file`', 'Upload file'],
    ['## Life of a *save*', 'Life of a save'],
    ['[Reader](docs/reader.md) & ~~old~~ editor', 'Reader & old editor'],
    ['_Platform_ notes', 'Platform notes'],
  ])('turns %j into %j', (raw, plain) => {
    expect(plainGroupName(raw)).toBe(plain);
  });

  it.each(['REST: Workspaces & canvases', 'Acceptance: Markdown canvas', 'AI & agents', 'snake_case in a sentence'])(
    'keeps the readable name %j unchanged', name => {
      expect(plainGroupName(name)).toBe(name);
    });

  it('keeps the original text when nothing readable remains', () => {
    expect(plainGroupName(' ** ')).toBe('**');
  });
});
