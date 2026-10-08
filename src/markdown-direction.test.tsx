// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BlockContent } from './Loaders';
import type { CanvasBlock } from '../shared/types';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { rehypeMarkdownDirection } from './markdown-direction';

afterEach(cleanup);

it('automatically directs mixed Markdown blocks and preserves explicit HTML directions and isolated code', () => {
  const block: CanvasBlock = { id: 'rtl', title: 'עברית', kind: 'markdown', file: 'rtl.md',
    x: 0, y: 0, width: 600, height: 400, links: [], content: [
      '# שלום עולם', '', 'مرحبا بالعالم', '', 'English paragraph.', '', '- פריט ראשון', '',
      '> ציטוט בעברית', '', '| כותרת | Value |', '| --- | --- |', '| תוכן | 42 |', '',
      'קוד `const x = 1`', '', '```\nconst x = "שלום";\n```', '',
      '<div dir="rtl"><p>English inside an explicit RTL section.</p></div>',
      '<p dir="ltr">פסקה עם כיוון מפורש</p>',
    ].join('\n') };
  const view = render(<BlockContent block={block} canvasId="canvas" onUpdateBlock={async () => {}} onError={message => { throw new Error(message); }}/>);
  for (const selector of ['h1', 'p', 'li', 'th', 'td']) {
    expect(view.container.querySelector(selector)?.getAttribute('dir'), selector).toBe('auto');
  }
  for (const selector of ['ul', 'blockquote', 'table']) expect(view.container.querySelector(selector)?.getAttribute('dir')).toBe('rtl');
  expect(screen.getByText('English inside an explicit RTL section.').getAttribute('dir')).toBeNull();
  expect(screen.getByText('פסקה עם כיוון מפורש').getAttribute('dir')).toBe('ltr');
  for (const code of view.container.querySelectorAll('code')) expect(code.getAttribute('dir')).toBe('ltr');
});

it('directs containers from prose, skips code and comments, and handles neutral text and explicit child directions', () => {
  const view = render(<ReactMarkdown rehypePlugins={[rehypeRaw, rehypeMarkdownDirection]}>{[
    '<blockquote><!-- comment --><pre>English code</pre><code>more code</code><p><strong>שלום</strong></p></blockquote>',
    '<blockquote><p dir="ltr">עברית</p></blockquote>',
    '<blockquote><p dir="rtl">English</p></blockquote>',
    '<blockquote><p>123 !</p></blockquote>',
    '<ul><li>English <em>item</em></li></ul>',
  ].join('\n')}</ReactMarkdown>);
  expect([...view.container.querySelectorAll('blockquote')].map(node => node.getAttribute('dir'))).toEqual(['rtl', 'ltr', 'rtl', 'auto']);
  expect(view.container.querySelector('ul')?.getAttribute('dir')).toBe('ltr');
  expect(view.container.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
});
