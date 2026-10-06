import { describe, expect, it } from 'vitest';
import { excerpt } from './excerpt.js';

describe('document excerpts', () => {
  it('finds a dated line far beyond the start of a long document', () => {
    const content = `# Roadmap\n${'Background material.\n'.repeat(300)}Milestone moved to 2026-09-26.\n${'Appendix material.\n'.repeat(300)}`;
    const result = excerpt(content, { budget: 500, focus: 'dates' });

    expect(content.indexOf('2026-09-26')).toBeGreaterThan(5000);
    expect(result.extracts).toContain('Milestone moved to 2026-09-26.');
    expect(result.head).toBe(content.slice(0, 200));
    expect(result.tail).toBe(content.slice(-100));
    expect(result.head.length + result.tail.length + result.extracts.length).toBeLessThanOrEqual(500);
  });

  it('finds a date even when it occurs deep inside one long line', () => {
    const content = `${'x'.repeat(5000)} The deadline is 2027-01-14. ${'y'.repeat(5000)}`;
    const result = excerpt(content, { budget: 300, focus: 'dates' });
    expect(result.extracts).toContain('2027-01-14');
  });

  it('keeps Hebrew headings, including Setext headings, in a capped outline', () => {
    const content = `# התחלה\n\nהתקנה\n------\n\n## שלבים\n${Array.from({ length: 50 }, (_, index) => `### כותרת ${index}`).join('\n')}`;
    const result = excerpt(content, { budget: 120 });

    expect(result.outline.split('\n')).toHaveLength(40);
    expect(result.outline).toContain('# התחלה');
    expect(result.outline).toContain('## התקנה');
    expect(result.outline).toContain('## שלבים');
    expect(result.outline).not.toContain('כותרת 49');
  });

  it('extracts numbered and bulleted instructions under step headings', () => {
    const content = [
      '# Guide',
      '- General context',
      'Background information that continues for several lines and stays outside the setup section.',
      '# Setup',
      '1. Get access',
      '2. Set the token',
      '## התקנה',
      '- הפעל את השירות',
      '# Reference',
      '- Not an instruction',
      'End notes that make the tail long enough to keep all instructions in the middle of the document.',
    ].join('\n');
    const result = excerpt(content, { budget: 150, focus: 'steps' });

    expect(result.extracts).toContain('1. Get access');
    expect(result.extracts).toContain('2. Set the token');
    expect(result.extracts).toContain('- הפעל את השירות');
    expect(result.extracts).not.toContain('General context');
    expect(result.extracts).not.toContain('Not an instruction');
  });

  it('recognizes written dates, numeric dates, versions, and status markers', () => {
    const middle = ['Revised on September 26, 2026.', 'Status: blocked', 'Version v1.2 is deprecated.', 'As of 26/09/2026, review again.'].join('\n');
    const content = `${'Preamble\n'.repeat(30)}${middle}\n${'End matter\n'.repeat(30)}`;
    const result = excerpt(content, { budget: 600, focus: 'dates' });

    expect(result.extracts).toContain('September 26, 2026');
    expect(result.extracts).toContain('Status: blocked');
    expect(result.extracts).toContain('v1.2');
    expect(result.extracts).toContain('26/09/2026');
  });

  it('extracts claim sentences while ignoring fenced examples', () => {
    const content = `${'Intro\n'.repeat(30)}The default timeout is 30 seconds. This is background.\nUsers must retry once.\n\`\`\`md\nNever say this is a claim.\n\`\`\`\n${'End\n'.repeat(30)}`;
    const result = excerpt(content, { budget: 300, focus: 'claims' });

    expect(result.extracts).toContain('The default timeout is 30 seconds.');
    expect(result.extracts).toContain('Users must retry once.');
    expect(result.extracts).not.toContain('This is background.');
    expect(result.extracts).not.toContain('Never say this is a claim.');
  });

  it('uses the full head for a short document without duplicating its tail', () => {
    const content = '# Short\nOnly a sentence.';
    expect(excerpt(content, { budget: 500, focus: 'claims' })).toEqual({
      outline: '# Short', head: content, tail: '', extracts: '',
    });
  });

  it('uses the reserved middle budget when no focus is specified', () => {
    const content = `${'A'.repeat(700)} MIDDLE CLAIM ${'Z'.repeat(700)}`;
    const result = excerpt(content, { budget: 900 });
    expect(result.extracts).toContain('MIDDLE CLAIM');
    expect(result.head.length + result.tail.length + result.extracts.length).toBeLessThanOrEqual(900);
  });
});
