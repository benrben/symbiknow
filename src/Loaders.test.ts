// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CanvasBlock } from '../shared/types';
import { BlockContent, calculateResult, compileRestrictedMdx, imageName, toggleTaskCheckbox, validateRestrictedMdx } from './Loaders';

const renderers = vi.hoisted(() => ({
  highlight: vi.fn(), diagram: vi.fn(), slides: vi.fn(),
}));

vi.mock('shiki', () => ({ codeToHtml: renderers.highlight }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderers.diagram } }));
vi.mock('@marp-team/marp-core', () => ({ Marp: class { render(content: string) { return renderers.slides(content); } } }));

afterEach(() => {
  cleanup();
  renderers.highlight.mockReset();
  renderers.diagram.mockReset();
  renderers.slides.mockReset();
});

function block(kind: CanvasBlock['kind'], content: string): CanvasBlock {
  return { id: 'site & docs', title: 'Team Docs', file: 'docs.md', kind, content,
    x: 0, y: 0, width: 400, height: 300, links: [] };
}

function renderBlock(kind: CanvasBlock['kind'], content: string): string {
  return renderToStaticMarkup(createElement(BlockContent, {
    block: block(kind, content), canvasId: 'Team Space',
    onUpdateBlock: async () => {}, onError: () => {},
  }));
}

function mountBlock(kind: CanvasBlock['kind'], content: string,
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void> = async () => {},
  onError: (message: string) => void = () => {}, fullPage = false) {
  return render(createElement(BlockContent, {
    block: block(kind, content), canvasId: 'Team Space', onUpdateBlock, onError, fullPage,
  }));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe('toggleTaskCheckbox', () => {
  it('updates the selected Markdown task and keeps other content intact', () => {
    const source = '# Launch\n- [ ] Draft\n- [x] Review\n';
    expect(toggleTaskCheckbox(source, 1, false)).toBe('# Launch\n- [ ] Draft\n- [ ] Review\n');
  });

  it('does not count checkbox-looking code fences', () => {
    const source = '```md\n- [ ] Example\n```\n- [ ] Real task';
    expect(toggleTaskCheckbox(source, 0, true)).toBe('```md\n- [ ] Example\n```\n- [x] Real task');
  });

  it('returns the unchanged file for an invalid index', () => {
    const source = '- [ ] Only task';
    expect(toggleTaskCheckbox(source, 5, true)).toBe(source);
  });

  it('ignores tasks in tilde fences until a matching closing marker', () => {
    const source = '~~~~md\n- [ ] Example\n~~~\n- [ ] Still code\n~~~~\n1. [X] Actual task';
    expect(toggleTaskCheckbox(source, 0, false)).toBe(source.replace('1. [X] Actual task', '1. [ ] Actual task'));
  });

  it('supports each Markdown list marker and leaves unmatched tasks intact', () => {
    const source = '* [ ] First\n+ [ ] Second\n2) [ ] Third';
    expect(toggleTaskCheckbox(source, 2, true)).toBe('* [ ] First\n+ [ ] Second\n2) [x] Third');
    expect(toggleTaskCheckbox(source, -1, true)).toBe(source);
  });

  it('updates quoted and nested tasks while preserving frontmatter and formatting', () => {
    const source = '---\ntitle: Tasks\n---\n> - [ ] Quoted\n- [ ] Parent\n  - [x] Nested\n';
    expect(toggleTaskCheckbox(source, 0, true)).toContain('> - [x] Quoted');
    expect(toggleTaskCheckbox(source, 2, false)).toBe(source.replace('  - [x] Nested', '  - [ ] Nested'));
  });
});

describe('restricted MDX', () => {
  it('renders Markdown and registered live components with literal props', async () => {
    const module = await compileRestrictedMdx('# Tools\n\n<Calculator initial="7" />');
    const html = renderToStaticMarkup(createElement(module.default, {
      components: { Calculator: ({ initial }: { initial: string }) => createElement('span', null, initial) },
    }));
    expect(html).toContain('<h1>Tools</h1>');
    expect(html).toContain('<span>7</span>');
  });

  it.each([
    'import X from "./X"\n\n<X />',
    'export const answer = 42',
    'The answer is {1 + 1}',
    '<Calculator initial={1 + 1} />',
    '<Unknown />',
  ])('rejects executable or unknown MDX: %s', async (source) => {
    await expect(compileRestrictedMdx(source)).rejects.toThrow();
  });

  it('accepts registered chart components and rejects executable nested nodes', async () => {
    const module = await compileRestrictedMdx('<Chart title="Q3" values="1,2,3" />');
    const html = renderToStaticMarkup(createElement(module.default, {
      components: { Chart: ({ title }: { title: string }) => createElement('span', null, title) },
    }));
    expect(html).toContain('<span>Q3</span>');
    expect(() => validateRestrictedMdx({ children: [{ type: 'mdxTextExpression' }] }))
      .toThrow('JavaScript expressions and imports');
  });

  it('requires plain text props and named registered components', () => {
    expect(() => validateRestrictedMdx({ type: 'mdxJsxFlowElement', name: null })).toThrow('fragment');
    expect(() => validateRestrictedMdx({
      type: 'mdxJsxTextElement', name: 'Calculator',
      attributes: [{ type: 'mdxJsxExpressionAttribute', value: 'danger()' }],
    })).toThrow('plain text');
    expect(() => validateRestrictedMdx({
      type: 'mdxJsxFlowElement', name: 'Chart', attributes: [{ type: 'mdxJsxAttribute', name: 'title', value: 'Sales' }],
    })).not.toThrow();
    expect(() => validateRestrictedMdx({ type: 'mdxJsxFlowElement', name: 'Chart' })).not.toThrow();
  });
});

describe('MDX calculator', () => {
  it.each([
    ['7', '2', '+', '9'],
    ['7', '2', '−', '5'],
    ['7', '2', '×', '14'],
    ['7', '2', '÷', '3.5'],
    ['7', '0', '÷', 'Cannot divide by zero'],
    ['invalid', '2', '+', 'Enter numbers'],
    ['7', 'Infinity', '+', 'Enter numbers'],
  ])('calculates %s %s %s as %s', (left, right, operation, expected) => {
    expect(calculateResult(left, right, operation)).toBe(expected);
  });
});

describe('block loaders', () => {
  it('describes every Markdown and HTML image, keeping written alt text and titles', () => {
    const html = renderBlock('markdown', '![Flow chart](a.png) ![](docs/release_plan-v2.svg?raw=1) <img src="team%20photo.jpg"> ![](x.png "Captioned")');
    expect(html).toContain('alt="Flow chart"');
    expect(html).toContain('alt="Image: release plan v2"');
    expect(html).toContain('alt="Image: team photo"');
    expect(html).toContain('alt="Captioned"');
    expect(imageName(undefined)).toBe('Image');
    expect(imageName('https://example.com/')).toBe('Image');
  });
  it('renders safe HTML inside Markdown and previews uploaded HTML documents in a sandbox', () => {
    const inline = renderBlock('markdown', '# Intro\n\n<div><strong>HTML detail</strong></div><script>window.bad = true</script>');
    expect(inline).toContain('<strong>HTML detail</strong>');
    expect(inline).not.toContain('<script>');
    mountBlock('markdown', '---\nformat: html\n---\n<!doctype html><html><body><h1>Landing page</h1></body></html>');
    const preview = screen.getByTitle('Team Docs HTML preview') as HTMLIFrameElement;
    const sandbox = preview.getAttribute('sandbox')!.split(' ');
    expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups']));
    expect(sandbox).not.toContain('allow-same-origin');
    expect(preview.getAttribute('srcdoc')).toContain('Landing page');
  });
  it('renders an HTML page as a page even when it was saved with another loader', () => {
    mountBlock('website', '---\nformat: html\n---\n<!doctype html><html><body><h1>Architecture</h1></body></html>');
    const preview = screen.getByTitle('Team Docs HTML preview') as HTMLIFrameElement;
    expect(preview.getAttribute('srcdoc')).toContain('Architecture');
    expect(screen.queryByText(/Website setup needed/)).toBeNull();
  });

  it('renders Markdown tasks and code without exposing frontmatter', () => {
    const html = renderBlock('markdown', '---\ntitle: Hidden\n---\n# Visible\n- [ ] Review\n\n```ts\nconst answer = 42\n```');
    expect(html).toContain('<h1 dir="auto">Visible</h1>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('const answer = 42');
    expect(html).not.toContain('title: Hidden');
  });

  it('renders diagram and slide loading states for asynchronous loaders', () => {
    expect(renderBlock('markdown', '```mermaid\nflowchart LR\nA-->B\n```')).toContain('Rendering diagram');
    expect(renderBlock('slides', '# Slide one')).toContain('Rendering slides');
    expect(renderBlock('mdx', '<Calculator />')).toContain('Rendering components');
  });

  it('shows the static website preview and opens the full site separately', () => {
    const html = renderBlock('website', '# Team Docs');
    expect(html).toContain('/api/canvases/Team%20Space/blocks/site%20%26%20docs/site/?static=1');
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).toContain('Open site');
  });

  it('keeps ordinary links and embeds recognized video links', () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost/' } });
    try {
      const html = renderBlock('markdown', '[Notes](https://example.com/notes)\n\n[Clip](https://youtu.be/example)');
      expect(html).toContain('href="https://example.com/notes"');
      expect(html).toContain('loader-video');
      expect(html).toContain('Loading video');
      const direct = renderBlock('markdown', '[Clip](http://example.com/video.mp4)');
      expect(direct).toContain('<video src="http://example.com/video.mp4" controls="" preload="metadata"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders inline code and handles an unusable page URL for media links', () => {
    vi.stubGlobal('window', { location: { href: 'not a valid base URL' } });
    try {
      const html = renderBlock('markdown', '`inline` and [Clip](https://example.com/video.mp4)');
      expect(html).toContain('<code dir="ltr">inline</code>');
      expect(html).toContain('href="https://example.com/video.mp4"');
      expect(html).not.toContain('loader-video');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('interactive block rendering', () => {
  it('saves a checked Markdown task and reports a failed save', async () => {
    const update = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
    const onError = vi.fn();
    const view = mountBlock('markdown', '- [ ] Review', update, onError);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('site & docs', { content: '- [x] Review' }));
    view.rerender(createElement(BlockContent, {
      block: block('markdown', '- [ ] Review'), canvasId: 'Team Space', onUpdateBlock: update, onError,
    }));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not save checkbox: Disk full'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('shows a generic save error when the storage layer rejects without an Error object', async () => {
    const update = vi.fn().mockRejectedValue('offline');
    const onError = vi.fn();
    mountBlock('markdown', '- [ ] Review', update, onError);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not save checkbox.'));
  });

  it('saves quoted Markdown tasks', async () => {
    const update = vi.fn();
    const onError = vi.fn();
    mountBlock('markdown', '> - [ ] Quoted task', update, onError);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('site & docs', { content: '> - [x] Quoted task' }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps card code readable without loading syntax highlighting', async () => {
    mountBlock('markdown', '```ts\nconst answer = 42\n```');
    expect(screen.getByText('const answer = 42').closest('pre')).not.toBeNull();
    await act(async () => {});
    expect(renderers.highlight).not.toHaveBeenCalled();
    expect(document.querySelector('.shiki')).toBeNull();
  });

  it('highlights code in the full-page reader and displays a diagram returned by its renderer', async () => {
    renderers.highlight.mockResolvedValue('<pre class="shiki">const answer = 42</pre>');
    renderers.diagram.mockResolvedValue({ svg: '<svg data-diagram="ready"></svg>' });
    mountBlock('markdown', '```ts\nconst answer = 42\n```\n\n```mermaid\nflowchart LR\nA-->B\n```', undefined, undefined, true);
    await waitFor(() => expect(document.querySelector('.shiki')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-diagram="ready"]')).not.toBeNull());
    expect(renderers.highlight).toHaveBeenCalledWith('const answer = 42', { lang: 'ts', theme: 'github-light' });
    expect(renderers.diagram).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'flowchart LR\nA-->B');
  });

  it('keeps source code readable when syntax highlighting fails', async () => {
    renderers.highlight.mockRejectedValue(new Error('Theme unavailable'));
    mountBlock('markdown', '```ts\nconst safe = true\n```', undefined, undefined, true);
    await waitFor(() => expect(renderers.highlight).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(screen.getByText('const safe = true')).not.toBeNull();
    expect(document.querySelector('.shiki')).toBeNull();
  });

  it('shows renderer failures inside the affected block', async () => {
    renderers.diagram.mockRejectedValue(new Error('Invalid flowchart'));
    mountBlock('markdown', '```mermaid\ninvalid\n```');
    expect((await screen.findByRole('alert')).textContent).toContain('Mermaid: Invalid flowchart');
    cleanup();
    renderers.slides.mockImplementation(() => { throw new Error('Invalid deck'); });
    mountBlock('slides', '# Broken slide');
    expect((await screen.findByRole('alert')).textContent).toContain('Marp: Invalid deck');
  });

  it('uses a readable fallback for non-Error renderer failures', async () => {
    renderers.diagram.mockRejectedValue('bad diagram');
    mountBlock('markdown', '```mermaid\ninvalid\n```');
    expect((await screen.findByRole('alert')).textContent).toContain('Diagram could not be rendered.');
    cleanup();
    renderers.slides.mockImplementation(() => { throw 'bad deck'; });
    mountBlock('slides', '# Broken slide');
    expect((await screen.findByRole('alert')).textContent).toContain('Slides could not be rendered.');
  });

  it('navigates rendered slides and keeps the iframe sandboxed', async () => {
    renderers.slides.mockReturnValue({ html: '<section>One</section><section>Two</section>', css: 'body{color:black}' });
    mountBlock('slides', '# One\n\n---\n\n# Two');
    const iframe = await screen.findByTitle('Slide preview') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.srcdoc).toContain('One');
    expect(screen.getByText('1 / 2')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByText('2 / 2')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Next slide' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(screen.getByText('1 / 2')).not.toBeNull();
  });

  it('still presents a single slide when the renderer returns no section tags', async () => {
    renderers.slides.mockReturnValue({ html: '<div>Cover</div>', css: '' });
    mountBlock('slides', '# Cover');
    expect(await screen.findByText('1 / 1')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Next slide' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders live MDX components and reports unsafe MDX in the block', async () => {
    mountBlock('mdx', '<Calculator initial="7" />\n\n<Chart title="Sales" values="1,2,3" />');
    const first = await screen.findByLabelText('First number');
    expect((first as HTMLInputElement).value).toBe('7');
    fireEvent.change(screen.getByLabelText('Second number'), { target: { value: '2' } });
    expect(screen.getByText('9')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: '÷' } });
    expect(screen.getByText('3.5')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('First number'), { target: { value: '8' } });
    expect(screen.getByText('4')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Sales: 1, 2, 3' })).not.toBeNull();
    cleanup();
    mountBlock('mdx', 'The answer is {1 + 1}');
    expect((await screen.findByRole('alert')).textContent).toContain('MDX: JavaScript expressions and imports');
  });

  it('filters invalid chart values and renders default component props', async () => {
    mountBlock('mdx', '<Chart title="Filtered" values="NaN,-1,0,2" />\n\n<Calculator />');
    expect(await screen.findByRole('img', { name: 'Filtered: 0, 2' })).not.toBeNull();
    expect((screen.getByLabelText('First number') as HTMLInputElement).value).toBe('0');
    cleanup();
    mountBlock('mdx', '<Chart />');
    expect(await screen.findByRole('img', { name: 'Chart: 4, 7, 3, 6' })).not.toBeNull();
  });

  it('does not apply a late diagram result after its block is removed', async () => {
    let resolveDiagram: (value: { svg: string }) => void = () => {};
    renderers.diagram.mockReturnValue(new Promise(resolve => { resolveDiagram = resolve; }));
    mountBlock('markdown', '```mermaid\nflowchart LR\nA-->B\n```');
    await waitFor(() => expect(renderers.diagram).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => { resolveDiagram({ svg: '<svg data-late="true"></svg>' }); });
    expect(document.querySelector('[data-late="true"]')).toBeNull();
  });

  it.each(['resolve', 'reject'])('ignores a late code renderer %s after unmount', async outcome => {
    const pending = deferred<string>();
    renderers.highlight.mockReturnValue(pending.promise);
    mountBlock('markdown', '```ts\nconst late = true\n```', undefined, undefined, true);
    await waitFor(() => expect(renderers.highlight).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => {
      if (outcome === 'resolve') pending.resolve('<pre class="late-highlight">Done</pre>');
      else pending.reject(new Error('Renderer stopped'));
    });
    expect(document.querySelector('.late-highlight')).toBeNull();
  });

  it('ignores a late diagram failure after unmount', async () => {
    const pending = deferred<{ svg: string }>();
    renderers.diagram.mockReturnValue(pending.promise);
    mountBlock('markdown', '```mermaid\nflowchart LR\nA-->B\n```');
    await waitFor(() => expect(renderers.diagram).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => { pending.reject(new Error('Renderer stopped')); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['resolve', 'reject'])('ignores a late slide renderer %s after unmount', async outcome => {
    if (outcome === 'resolve') renderers.slides.mockReturnValue({ html: '<section>Late</section>', css: '' });
    else renderers.slides.mockImplementation(() => { throw new Error('Renderer stopped'); });
    mountBlock('slides', '# One');
    cleanup();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(renderers.slides).toHaveBeenCalledOnce();
    expect(screen.queryByTitle('Slide preview')).toBeNull();
  });

  it.each(['<Chart />', 'The answer is {1 + 1}'])('ignores a late MDX result after unmount: %s', async source => {
    mountBlock('mdx', source);
    cleanup();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('uses a generic MDX error when the evaluator rejects without an Error object', async () => {
    vi.doMock('@mdx-js/mdx', () => ({ evaluate: vi.fn().mockRejectedValue('renderer stopped') }));
    try {
      mountBlock('mdx', '# Broken');
      expect((await screen.findByRole('alert')).textContent).toContain('MDX: MDX could not be rendered.');
    } finally {
      vi.doUnmock('@mdx-js/mdx');
    }
  });
});
