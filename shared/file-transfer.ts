import type { BlockKind } from './types.js';

export type UploadedSource = { title: string; kind: BlockKind; content: string };
export type LoaderDetection = { kind: BlockKind; confidence: 1 } | { fallback: true };

const htmlFrontmatter = /^---\r?\nformat:\s*html\s*\r?\n---(?:\r?\n|$)/i;

function frontmatterParts(content: string): { metadata: string; body: string } {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { metadata: '', body: content };
  const rest = content.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  return closing
    ? { metadata: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length) }
    : { metadata: '', body: content };
}

function frontmatterValue(metadata: string, key: string): string {
  const value = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'im').exec(metadata)?.[1]?.trim() ?? '';
  return value.replace(/^(['"])(.*)\1$/, '$2').trim();
}

function bodySignals(body: string): { slideBreaks: number; componentBlock: boolean; proseTag: boolean; exportConst: boolean } {
  const lines = body.split(/\r?\n/);
  let fence = '';
  let slideBreaks = 0;
  let componentBlock = false;
  let proseTag = false;
  let exportConst = false;

  lines.forEach((line, index) => {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (fence) {
      if (marker[0] === fence[0] && marker.length >= fence.length && line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = '';
      return;
    }
    if (marker) { fence = marker; return; }
    if (index > 0 && index < lines.length - 1 && line.trim() === '---') slideBreaks += 1;
    if (/^[ \t]*export[ \t]+const\b/.test(line)) exportConst = true;
    if (/<[A-Z]\w*/.test(line)) {
      if (/^[ \t]*<[A-Z]\w*/.test(line)) componentBlock = true;
      else proseTag = true;
    }
  });

  return { slideBreaks, componentBlock, proseTag, exportConst };
}

/** Resolve clear loader signatures locally; ask Jev only for a single slide break or a component tag in prose. */
export function detectLoader(content: string): LoaderDetection {
  const { metadata, body } = frontmatterParts(content);
  if (frontmatterValue(metadata, 'format').toLowerCase() === 'html') return { kind: 'markdown', confidence: 1 };
  if (/^(mkdocs|hugo|docusaurus)$/i.test(frontmatterValue(metadata, 'generator')) && frontmatterValue(metadata, 'source')) {
    return { kind: 'website', confidence: 1 };
  }
  if (frontmatterValue(metadata, 'marp').toLowerCase() === 'true') return { kind: 'slides', confidence: 1 };

  const { slideBreaks, componentBlock, proseTag, exportConst } = bodySignals(body);
  if (slideBreaks >= 2) return { kind: 'slides', confidence: 1 };
  if (componentBlock || exportConst) return { kind: 'mdx', confidence: 1 };
  if (slideBreaks === 1 || proseTag) return { fallback: true };
  return { kind: 'markdown', confidence: 1 };
}

/** An uploaded HTML page: its source starts with `format: html` frontmatter. */
export function isHtmlDocument(content: string): boolean {
  return htmlFrontmatter.test(content);
}

/** HTML pages always use the Markdown loader, which renders them as a sandboxed page. "website" is only for generated doc sites. */
export function loaderFor(kind: BlockKind, content: string): BlockKind {
  return isHtmlDocument(content) ? 'markdown' : kind;
}

/** Mark raw HTML as an HTML page so it renders instead of showing its source. */
export function asHtmlDocument(source: string): string {
  return isHtmlDocument(source) ? source : `---\nformat: html\n---\n${source}`;
}

/** Map the `html` convenience loader onto the stored format. */
export function storedDocument<T extends { kind?: string; content?: string }>(input: T): T {
  if (input.kind !== 'html') return input;
  return { ...input, kind: 'markdown', ...(input.content === undefined ? {} : { content: asHtmlDocument(input.content) }) };
}

export function uploadedSource(filename: string, source: string): UploadedSource {
  const name = filename.replaceAll('\\', '/').split('/').at(-1) ?? '';
  if (!/\.(md|mdx|html)$/i.test(name)) throw new Error('Choose a .md, .mdx, or .html file: ' + name);
  const title = name.replace(/\.(md|mdx|html)$/i, '').trim();
  if (!title) throw new Error('The file needs a name before its extension.');
  if (/\.html$/i.test(name)) return { title, kind: 'markdown', content: asHtmlDocument(source) };
  return { title, kind: /\.mdx$/i.test(name) ? 'mdx' : 'markdown', content: source };
}
