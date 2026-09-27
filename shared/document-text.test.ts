import { describe, expect, it } from 'vitest';
import { documentText } from './document-text.js';

describe('document text', () => {
  it('reads the words of an uploaded HTML page, not its styles or scripts', () => {
    const text = documentText('---\nformat: html\n---\n<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Project overview</h1><p>Goals &amp; scope</p></body></html>');
    expect(text).toBe('Project overview\nGoals & scope');
    expect(documentText('---\ntitle: x\n---\n# Markdown')).toBe('# Markdown');
  });
});
