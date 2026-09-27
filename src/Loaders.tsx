import { lazy, memo, Suspense, useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { CanvasBlock } from '../shared/types';

const ReactPlayer = lazy(() => import('react-player'));

interface BlockContentProps {
  block: CanvasBlock;
  canvasId: string;
  onUpdateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  onError: (message: string) => void;
  /** Size uploaded HTML to its content instead of filling a fixed card. */
  fullPage?: boolean;
}

function bodyWithoutFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function uploadedHtml(content: string): boolean {
  return /^---\r?\nformat:\s*html\s*\r?\n---(?:\r?\n|$)/i.test(content);
}

type TaskNode = { checked?: boolean | null; position?: { start: { offset?: number } }; children?: TaskNode[] };
const taskProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

function collectTasks(node: TaskNode, tasks: TaskNode[]): void {
  if (typeof node.checked === 'boolean') tasks.push(node);
  for (const child of node.children ?? []) collectTasks(child, tasks);
}

/** Update the parsed GFM task marker without reformatting the rest of the file. */
export function toggleTaskCheckbox(content: string, taskIndex: number, checked: boolean): string {
  const prefix = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0] ?? '';
  const body = content.slice(prefix.length);
  const tasks: TaskNode[] = [];
  collectTasks(taskProcessor.parse(body), tasks);
  const offset = tasks[taskIndex]?.position?.start.offset;
  if (offset === undefined) return content;
  const marker = /^((?:[-*+]|\d+[.)])\s+\[)[ xX]\]/.exec(body.slice(offset))!;
  const checkbox = offset + marker[1].length;
  return prefix + body.slice(0, checkbox) + (checked ? 'x' : ' ') + body.slice(checkbox + 1);
}

function safeMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function directVideoUrl(url: string): boolean { return /\.(?:mp4|webm|ogg)(?:[?#]|$)/i.test(url); }
function hostedVideoUrl(url: string): boolean { return /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\//i.test(url); }

function videoKind(url: string | undefined): 'direct' | 'hosted' | null {
  if (!url || !safeMediaUrl(url)) return null;
  if (directVideoUrl(url)) return 'direct';
  if (hostedVideoUrl(url)) return 'hosted';
  return null;
}

function CodeBlock({ language, code, highlight }: { language: string; code: string; highlight: boolean }) {
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    if (!highlight) return;
    let current = true;
    setHtml(undefined);
    void import('shiki').then(({ codeToHtml }) => codeToHtml(code, {
      lang: language,
      theme: 'github-light',
    })).then((highlighted) => {
      if (current) setHtml(highlighted);
    }).catch(() => {
      if (current) setHtml('');
    });
    return () => { current = false; };
  }, [code, language, highlight]);

  if (highlight && html) return <div className="loader-code" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className="loader-code"><code>{code}</code></pre>;
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState('');
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    setSvg(undefined);
    setError('');
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });
      return mermaid.render(`mermaid-${reactId}`, source);
    }).then((result) => {
      if (current) setSvg(result.svg);
    }).catch((reason) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Diagram could not be rendered.');
    });
    return () => { current = false; };
  }, [dark, reactId, source]);

  if (error) return <div className="loader-error" role="alert">Mermaid: {error}</div>;
  if (!svg) return <div className="loader-loading">Rendering diagram…</div>;
  return <div className="loader-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Reports the document height to the reader. It runs inside the sandbox, which has no access to this app. */
const heightReporter = '<script>(function(){function post(){parent.postMessage({symbiknowHtmlHeight:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)},"*")}'
  + 'addEventListener("load",post);if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);setTimeout(post,50)})()</script>';

/**
 * Uploaded HTML runs with scripts, forms, and popups, but without `allow-same-origin`, so it gets an opaque origin:
 * it cannot read this app's cookies, storage, or API responses, and the server rejects its write requests.
 */
function HtmlDocument({ title, source, fullPage }: { title: string; source: string; fullPage?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (!fullPage) return;
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const value = Number((event.data as { symbiknowHtmlHeight?: unknown } | null)?.symbiknowHtmlHeight);
      if (Number.isFinite(value) && value > 0) setHeight(Math.min(Math.ceil(value) + 8, 40_000));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [fullPage]);
  const srcDoc = useMemo(() => fullPage ? source + heightReporter : source, [fullPage, source]);
  return <div className={`loader-html${fullPage ? ' loader-html--full' : ''}`}>
    <iframe ref={frame} title={`${title} HTML preview`} srcDoc={srcDoc} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
      referrerPolicy="no-referrer" style={fullPage && height ? { height } : undefined}/>
  </div>;
}

function MarkdownContent({ block, onUpdateBlock, onError, fullPage }: Pick<BlockContentProps, 'block' | 'onUpdateBlock' | 'onError' | 'fullPage'>) {
  const [savingTask, setSavingTask] = useState(false);
  const markdown = bodyWithoutFrontmatter(block.content);
  let taskIndex = 0;

  async function setTask(index: number, checked: boolean) {
    const updated = toggleTaskCheckbox(block.content, index, checked);
    setSavingTask(true);
    try {
      await onUpdateBlock(block.id, { content: updated });
    } catch (reason) {
      onError(reason instanceof Error ? `Could not save checkbox: ${reason.message}` : 'Could not save checkbox.');
    } finally {
      setSavingTask(false);
    }
  }

  if (uploadedHtml(block.content)) return <HtmlDocument title={block.title} source={markdown} fullPage={fullPage}/>;

  return <div className="loader-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={{
      pre: ({ children }) => <div className="loader-pre">{children}</div>,
      code: ({ className, children }) => {
        const language = /language-([\w-]+)/.exec(className || '')?.[1];
        const source = String(children).replace(/\n$/, '');
        if (language === 'mermaid') return <MermaidDiagram source={source} />;
        if (language) return <CodeBlock language={language} code={source} highlight={Boolean(fullPage)} />;
        return <code>{children}</code>;
      },
      input: ({ checked }) => {
        const index = taskIndex++;
        return <input type="checkbox" checked={Boolean(checked)} disabled={savingTask} onChange={(event) => void setTask(index, event.target.checked)} />;
      },
      a: ({ href, children }) => {
        const media = videoKind(href);
        if (media === 'direct') {
          return <span className="loader-video"><video src={href} controls preload="metadata" /></span>;
        }
        if (media === 'hosted') {
          return <div className="loader-video"><Suspense fallback={<div className="loader-loading">Loading video…</div>}><ReactPlayer src={href} controls width="100%" height="100%" /></Suspense></div>;
        }
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
    }}>{markdown}</ReactMarkdown>
  </div>;
}

function SlideDeck({ content }: { content: string }) {
  const [slide, setSlide] = useState(0);
  const [deck, setDeck] = useState<{ html: string; css: string; count: number }>();
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setSlide(0);
    setDeck(undefined);
    setError('');
    void import('@marp-team/marp-core').then(({ Marp }) => {
      const result = new Marp({ html: false, script: false }).render(content);
      return { ...result, count: Math.max(1, (result.html.match(/<section\b/g) || []).length) };
    }).then((result) => {
      if (current) setDeck(result);
    }).catch((reason) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Slides could not be rendered.');
    });
    return () => { current = false; };
  }, [content]);

  const srcDoc = useMemo(() => deck ? `<!doctype html><html><head><meta charset="utf-8"><style>${deck.css}\nbody{margin:0;background:#f1f4f9;display:grid;place-items:center;min-height:100vh}.marpit{width:100%}.marpit>svg{display:none}.marpit>svg:nth-of-type(${slide + 1}){display:block;width:100%;height:auto}</style></head><body>${deck.html}</body></html>` : '', [deck, slide]);

  if (error) return <div className="loader-error" role="alert">Marp: {error}</div>;
  if (!deck) return <div className="loader-loading">Rendering slides…</div>;
  return <div className="loader-slides">
    <iframe title="Slide preview" srcDoc={srcDoc} sandbox="" />
    <nav className="loader-slides__controls" aria-label="Slide controls">
      <button disabled={slide === 0} onClick={() => setSlide((value) => value - 1)} aria-label="Previous slide">‹</button>
      <span>{slide + 1} / {deck.count}</span>
      <button disabled={slide >= deck.count - 1} onClick={() => setSlide((value) => value + 1)} aria-label="Next slide">›</button>
    </nav>
  </div>;
}

function WebsitePreview({ block, canvasId }: Pick<BlockContentProps, 'block' | 'canvasId'>) {
  if (canvasId === 'session-research') return <div className="loader-website">
    <div className="loader-website__footer">Save this research canvas to build and preview the website.</div>
    <div className="loader-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyWithoutFrontmatter(block.content)}</ReactMarkdown></div>
  </div>;
  const preview = `/api/canvases/${encodeURIComponent(canvasId)}/blocks/${encodeURIComponent(block.id)}/site/`;
  return <div className="loader-website">
    <iframe title={`${block.title} website preview`} src={`${preview}?static=1`} sandbox="allow-same-origin" loading="lazy" />
    <div className="loader-website__footer">Website preview <a href={preview} target="_blank" rel="noopener noreferrer">Open site ↗</a></div>
  </div>;
}

type MdxTreeNode = {
  type?: string;
  name?: string | null;
  attributes?: { type: string; name?: string; value?: string | null | object }[];
  children?: MdxTreeNode[];
};

const allowedMdxComponents = new Set(['Calculator', 'Chart']);
const executableMdxNodes = new Set(['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression']);
const jsxMdxNodes = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement']);

function validateMdxAttribute(attribute: NonNullable<MdxTreeNode['attributes']>[number]): void {
  if (attribute.type !== 'mdxJsxAttribute' || !attribute.name || (attribute.value !== null && typeof attribute.value !== 'string')) {
    throw new Error('MDX component props must be plain text.');
  }
}

function validateMdxName(name: MdxTreeNode['name']): void {
  if (!name || !allowedMdxComponents.has(name)) {
    throw new Error(`Component ${name || '(fragment)'} is not available in canvas MDX.`);
  }
}

function validateMdxComponent(node: MdxTreeNode): void {
  if (!jsxMdxNodes.has(node.type ?? '')) return;
  validateMdxName(node.name);
  for (const attribute of node.attributes ?? []) validateMdxAttribute(attribute);
}

export function validateRestrictedMdx(node: MdxTreeNode): void {
  if (executableMdxNodes.has(node.type ?? '')) {
    throw new Error('JavaScript expressions and imports are not enabled in canvas MDX.');
  }
  validateMdxComponent(node);
  for (const child of node.children ?? []) validateRestrictedMdx(child);
}

function restrictedMdxPlugin() {
  return (tree: MdxTreeNode) => validateRestrictedMdx(tree);
}

export async function compileRestrictedMdx(content: string) {
  const { evaluate } = await import('@mdx-js/mdx');
  return evaluate(bodyWithoutFrontmatter(content), {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [restrictedMdxPlugin],
  });
}

function divideResult(first: number, second: number): string {
  if (second === 0) return 'Cannot divide by zero';
  return String(first / second);
}

export function calculateResult(left: string, right: string, operation: string): string {
  const first = Number(left);
  const second = Number(right);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 'Enter numbers';
  if (operation === '+') return String(first + second);
  if (operation === '−') return String(first - second);
  if (operation === '×') return String(first * second);
  return divideResult(first, second);
}

function Calculator({ initial = '0' }: { initial?: string }) {
  const [left, setLeft] = useState(initial);
  const [right, setRight] = useState('0');
  const [operation, setOperation] = useState('+');
  const result = calculateResult(left, right, operation);

  return <div className="mdx-calculator">
    <label>First number<input type="number" value={left} onChange={(event) => setLeft(event.target.value)} /></label>
    <label>Operation<select value={operation} onChange={(event) => setOperation(event.target.value)}><option>+</option><option>−</option><option>×</option><option>÷</option></select></label>
    <label>Second number<input type="number" value={right} onChange={(event) => setRight(event.target.value)} /></label>
    <output>{result}</output>
  </div>;
}

function Chart({ title = 'Chart', values = '4,7,3,6' }: { title?: string; values?: string }) {
  const numbers = values.split(',').slice(0, 12).map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
  const maximum = Math.max(1, ...numbers);
  return <div className="mdx-chart" role="img" aria-label={`${title}: ${numbers.join(', ')}`}>
    <strong>{title}</strong>
    <div className="mdx-chart__bars">{numbers.map((value, index) => <div key={index} title={String(value)} style={{ height: `${Math.max(3, value / maximum * 100)}%` }}><span>{value}</span></div>)}</div>
  </div>;
}

type RestrictedMdxComponent = ComponentType<{
  components: { Calculator: typeof Calculator; Chart: typeof Chart };
}>;

function MdxContent({ content }: { content: string }) {
  const [Component, setComponent] = useState<RestrictedMdxComponent | null>(null);
  const [error, setError] = useState('');
  const source = bodyWithoutFrontmatter(content);

  useEffect(() => {
    let current = true;
    setComponent(null);
    setError('');
    void compileRestrictedMdx(source).then((module) => {
      if (current) setComponent(() => module.default as RestrictedMdxComponent);
    }).catch((reason) => {
      if (current) setError(reason instanceof Error ? reason.message : 'MDX could not be rendered.');
    });
    return () => { current = false; };
  }, [source]);

  if (error) return <div className="loader-error" role="alert">MDX: {error}</div>;
  if (!Component) return <div className="loader-loading">Rendering components…</div>;
  return <div className="loader-markdown loader-mdx-rendered"><Component components={{ Calculator, Chart }} /></div>;
}

export const BlockContent = memo(function BlockContent(props: BlockContentProps) {
  // An HTML page renders as a page whatever loader was chosen for it.
  if (uploadedHtml(props.block.content)) return <HtmlDocument title={props.block.title} source={bodyWithoutFrontmatter(props.block.content)} fullPage={props.fullPage}/>;
  switch (props.block.kind) {
    case 'markdown': return <MarkdownContent {...props} />;
    case 'slides': return <SlideDeck content={props.block.content} />;
    case 'website': return <WebsitePreview {...props} />;
    case 'mdx': return <MdxContent content={props.block.content} />;
  }
}, (before, after) => before.canvasId === after.canvasId && before.fullPage === after.fullPage
  && before.onUpdateBlock === after.onUpdateBlock && before.onError === after.onError
  && before.block.id === after.block.id && before.block.title === after.block.title
  && before.block.kind === after.block.kind && before.block.content === after.block.content);
