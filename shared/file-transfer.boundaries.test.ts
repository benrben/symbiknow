import { describe, expect, it } from 'vitest';
import { asHtmlDocument, detectLoader, isHtmlDocument, loaderFor, storedDocument, uploadedSource } from './file-transfer';

describe('file transfer format boundaries', () => {
  it('retains ordinary formats and normalizes the HTML convenience loader with and without content', () => {
    const markdown = { kind: 'markdown', content: '# Note', custom: 1 };
    expect(storedDocument(markdown)).toBe(markdown);
    expect(storedDocument({ kind: 'html', custom: 1 })).toEqual({ kind: 'markdown', custom: 1 });
    expect(storedDocument({ kind: 'html', content: '<h1>Page</h1>' })).toEqual({ kind: 'markdown', content: '---\nformat: html\n---\n<h1>Page</h1>' });
    const tagged = '---\r\nformat: HTML\r\n---\r\n<h1>Page</h1>';
    expect(isHtmlDocument(tagged)).toBe(true); expect(asHtmlDocument(tagged)).toBe(tagged);
    expect(loaderFor('mdx', '# Component')).toBe('mdx');
  });

  it('uses path basenames, extension case and source bytes when importing supported text files', () => {
    expect(uploadedSource('C:\\docs\\  Design.MDX', '\r\n<Chart />')).toEqual({ title: 'Design', kind: 'mdx', content: '\r\n<Chart />' });
    expect(uploadedSource('/notes/ Plan.md', '# Plan')).toEqual({ title: 'Plan', kind: 'markdown', content: '# Plan' });
    expect(uploadedSource('Page.HTML', '---\nformat: html\n---\nPage').content).toBe('---\nformat: html\n---\nPage');
    expect(() => uploadedSource('', '')).toThrow('Choose a .md, .mdx, or .html file:');
    expect(() => uploadedSource('report.pdf', '')).toThrow('Choose a .md, .mdx, or .html file: report.pdf');
    expect(() => uploadedSource(' .md', '')).toThrow('The file needs a name before its extension.');
  });

  it('treats unclosed frontmatter as content and preserves fences until a valid matching close', () => {
    expect(detectLoader('---\nmarp: true\nno closing marker')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('````md\n```\n~~~~\n```` trailing text\n<Widget />\n\n````\nPlain text')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('---\n generator: "hugo"\n source: \'docs\'\n---\n# Page')).toEqual({ kind: 'website', confidence: 1 });
    expect(detectLoader('---\n---\nPlain text')).toEqual({ kind: 'markdown', confidence: 1 });
    expect(detectLoader('---\nPlain text')).toEqual({ kind: 'markdown', confidence: 1 });
  });
});
