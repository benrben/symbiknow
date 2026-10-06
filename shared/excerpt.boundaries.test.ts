import { describe, expect, it } from 'vitest';
import { excerpt } from './excerpt';

describe('Markdown excerpt boundaries', () => {
  it('does not close a code fence on a fence marker followed by prose', () => {
    const source = `${'Background\n'.repeat(50)}\`\`\`\`markdown\n\`\`\`\` not a closing fence\nUsers must not treat this example as evidence.\n\`\`\`\`\nUsers should review the real policy.\n${'Appendix\n'.repeat(50)}`;
    const result = excerpt(source, { budget: 300, focus: 'claims' });
    expect(result.extracts).not.toContain('Users must not treat this example as evidence.');
    expect(result.extracts).toContain('Users should review the real policy.');
  });

  it('ignores mismatched and shorter fences, and recognizes Setext and closed ATX headings', () => {
    const source = '---\ntitle: Examples\n---\nInstallation\n===\n1. Install\n## Setup ##\n2. Configure\n###\n~~~js\n```\n~~\n# Hidden heading\n~~~\n# Reference\nEnd';
    const result = excerpt(source, { budget: 100, focus: 'steps' });
    expect(result.outline).toBe('# Installation\n## Setup\n# Reference');
    expect(result.outline).not.toContain('Hidden heading');
  });

  it.each([-1, Infinity, NaN])('rejects a non-finite or negative budget %s', budget => {
    expect(() => excerpt('# Note', { budget })).toThrow(RangeError);
  });

  it('supports zero, fractional and tiny budgets without duplicating or exceeding the allocation', () => {
    const content = 'xxxx\n1\n2\n3\nxxxx';
    expect(excerpt(content, { budget: 0, focus: 'claims' })).toEqual({ outline: '', head: '', tail: '', extracts: '' });
    expect(excerpt(content, { budget: 5.9, focus: 'claims' }).extracts).toBe('1');
    expect(excerpt(content, { budget: 9, focus: 'claims' }).extracts).toBe('1\n2\n3');
    expect(excerpt('', { budget: 3 })).toEqual({ outline: '', head: '', tail: '', extracts: '' });
    expect(excerpt('x'.repeat(20) + '\n must', { budget: 20, focus: 'claims' }).extracts).toBe('');
  });

  it('keeps a list item followed by a rule outside the outline and supports unclosed frontmatter as prose', () => {
    expect(excerpt('- Context\n---\nplain text', { budget: 0 }).outline).toBe('');
    expect(excerpt('---\nunclosed metadata\n# Visible', { budget: 0 }).outline).toBe('# Visible');
  });
});
