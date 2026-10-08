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

type BodySignals = { slideBreaks: number; componentBlock: boolean; proseTag: boolean; exportConst: boolean };

function closingFence(line: string, marker: string, fence: string) {
  return marker[0] === fence[0] && marker.length >= fence.length
    && line.slice(line.indexOf(marker) + marker.length).trim() === '';
}

function slideBreak(line: string, index: number, length: number) {
  return index > 0 && index < length - 1 && line.trim() === '---';
}

function proseSignals(line: string, index: number, length: number, signals: BodySignals) {
  if (slideBreak(line, index, length)) signals.slideBreaks++;
  if (/^[ \t]*export[ \t]+const\b/.test(line)) signals.exportConst = true;
  if (!/<[A-Z]\w*/.test(line)) return;
  if (/^[ \t]*<[A-Z]\w*/.test(line)) signals.componentBlock = true;
  else signals.proseTag = true;
}

function bodySignals(body: string): BodySignals {
  const lines = body.split(/\r?\n/);
  let fence = '';
  const signals: BodySignals = { slideBreaks: 0, componentBlock: false, proseTag: false, exportConst: false };
  lines.forEach((line, index) => {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (fence) { if (closingFence(line, marker, fence)) fence = ''; return; }
    if (marker) { fence = marker; return; }
    proseSignals(line, index, lines.length, signals);
  });
  return signals;
}

/** Resolve clear loader signatures locally. */
export function detectLoader(content: string): LoaderDetection {
  const { metadata, body } = frontmatterParts(content);
  return metadataLoader(metadata) ?? bodyLoader(bodySignals(body));
}

function metadataLoader(metadata: string): LoaderDetection | undefined {
  if (frontmatterValue(metadata, 'format').toLowerCase() === 'html') return { kind: 'markdown', confidence: 1 };
  if (/^(mkdocs|hugo|docusaurus)$/i.test(frontmatterValue(metadata, 'generator')) && frontmatterValue(metadata, 'source')) {
    return { kind: 'website', confidence: 1 };
  }
  if (frontmatterValue(metadata, 'marp').toLowerCase() === 'true') return { kind: 'slides', confidence: 1 };
  return undefined;
}

function bodyLoader({ slideBreaks, componentBlock, proseTag, exportConst }: BodySignals): LoaderDetection {
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
  const normalized = filename.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (!/\.(md|mdx|html)$/i.test(name)) throw new Error('Choose a .md, .mdx, or .html file: ' + name);
  const title = name.replace(/\.(md|mdx|html)$/i, '').trim();
  if (!title) throw new Error('The file needs a name before its extension.');
  if (/\.html$/i.test(name)) return { title, kind: 'markdown', content: asHtmlDocument(source) };
  return { title, kind: /\.mdx$/i.test(name) ? 'mdx' : 'markdown', content: source };
}

/** Export names describe the loader rather than the internal storage suffix. */
export function documentFilename(document: { id: string; kind: BlockKind; content: string }): string {
  if (document.kind === 'website') return document.id + '.symbi-site.json';
  const extension = isHtmlDocument(document.content) ? '.html' : document.kind === 'mdx' ? '.mdx' : '.md';
  return document.id + extension;
}
