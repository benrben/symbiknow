import type { Element, Root, RootContent, Text } from 'hast';
import { unified } from 'unified';
import rehypeRaw from 'rehype-raw';
import { SourcePassageCache } from './source-passage-cache.js';

export interface SourcePassage { start: number; end: number; quote: string; text: string; totalTextLength: number; headingLevel: number }
type HtmlNode = Root | RootContent;
type VisibleToken = Text | undefined;
type SourceRange = { start: number; end: number };
const htmlParser = unified().use(rehypeRaw);
const sourceCache = new SourcePassageCache();
const omitted = new Set(['head', 'title', 'script', 'style', 'noscript', 'template', 'pre', 'svg']);
const proseBlocks = new Set(['p', 'li', 'td', 'th', 'dt', 'dd', 'figcaption']);

function parsedHtml(content: string): Root {
  return htmlParser.runSync({ type: 'root', children: [{ type: 'raw', value: content }] } as Root) as Root;
}
function children(node: HtmlNode): HtmlNode[] { return 'children' in node ? node.children : []; }
function hidden(node: Element): boolean {
  return omitted.has(node.tagName) || Boolean(node.properties.hidden) || node.properties.ariaHidden === 'true';
}
function visibleTokens(node: HtmlNode): VisibleToken[] {
  if (node.type === 'text') return [node];
  if (node.type === 'element' && hidden(node)) return [undefined];
  if (node.type === 'comment') return [undefined];
  return children(node).flatMap(visibleTokens);
}
function normalized(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

/** Readable provider input is separate from the exact original bytes used as evidence. */
export function readablePassage(quote: string): string {
  if (!/[<&]/.test(quote)) return normalized(quote);
  return normalized(visibleTokens(parsedHtml(quote)).map(token => token?.value ?? '').join(''));
}
function exactPassage(content: string, start: number, end: number, headingLevel = 0): SourcePassage | undefined {
  const raw = content.slice(start, end);
  const quote = raw.trim().slice(0, 600);
  const text = readablePassage(quote);
  if (!text || /^[\s|:*-]+$/.test(text)) return undefined;
  const offset = start + raw.indexOf(quote);
  const totalTextLength = quote === raw.trim() ? text.length : readablePassage(raw.trim()).length;
  return { start: offset, end: offset + quote.length, quote, text, totalTextLength, headingLevel };
}
function tokenRuns(tokens: VisibleToken[]): Text[][] {
  const runs: Text[][] = [[]];
  for (const token of tokens) {
    if (token) runs[runs.length - 1].push(token);
    else runs.push([]);
  }
  return runs.filter(run => run.length);
}
function htmlHeadingLevel(node: HtmlNode): number {
  if (node.type !== 'element') return 0;
  return Number(node.tagName.match(/^h([1-6])$/)?.[1] ?? 0);
}
function passageContainer(node: HtmlNode): boolean {
  return node.type === 'text' || htmlHeadingLevel(node) > 0 || node.type === 'element' && proseBlocks.has(node.tagName);
}
function htmlPassages(content: string, node: HtmlNode, minimum: number): SourcePassage[] {
  if (node.type === 'element' && hidden(node)) return [];
  if (!passageContainer(node)) return children(node).flatMap(child => htmlPassages(content, child, minimum));
  const heading = htmlHeadingLevel(node);
  return tokenRuns(visibleTokens(node)).flatMap(run => {
    const passage = exactPassage(content, Math.max(minimum, run[0].position!.start.offset!), run.at(-1)!.position!.end.offset!, heading);
    return passage ? [passage] : [];
  });
}
function frontmatterEnd(content: string): number {
  return content.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)?.[0].length ?? 0;
}
function nextFence(current: string | undefined, marker: string): string | undefined {
  if (!current) return marker;
  if (marker[0] === current[0] && marker.length >= current.length) return undefined;
  return current;
}
function headingLevel(quote: string): number { return quote.match(/^(#{1,6})\s+/)?.[1].length ?? 0; }
function htmlDocument(content: string, start: number): boolean {
  const body = content.slice(start).trimStart().replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  return /^<(?:!doctype\s+html|[a-z][\w:-]*(?:\s|>))/i.test(body);
}
function ignoredHtmlRanges(node: HtmlNode): SourceRange[] {
  if (node.type === 'comment' || node.type === 'element' && hidden(node)) {
    return [{ start: node.position!.start.offset!, end: node.position!.end.offset! }];
  }
  return children(node).flatMap(ignoredHtmlRanges);
}
function visibleRanges(start: number, end: number, omittedRanges: SourceRange[]): SourceRange[] {
  const result: SourceRange[] = [];
  for (const range of omittedRanges.filter(range => range.end > start && range.start < end)) {
    if (range.start > start) result.push({ start, end: range.start });
    start = Math.max(start, range.end);
  }
  if (start < end) result.push({ start, end });
  return result;
}
function markdownLine(content: string, start: number, end: number, ignored: SourceRange[]): SourcePassage[] {
  const heading = headingLevel(content.slice(start, end).trim());
  return visibleRanges(start, end, ignored).flatMap(range => {
    const passage = exactPassage(content, range.start, range.end, heading);
    return passage ? [passage] : [];
  });
}
function markdownPassages(content: string, start: number): SourcePassage[] {
  const result: SourcePassage[] = [];
  const ignored = content.includes('<') ? ignoredHtmlRanges(parsedHtml(content)).sort((a, b) => a.start - b.start) : [];
  let fence: string | undefined;
  for (const match of content.slice(start).matchAll(/[^\n]+/g)) {
    const quote = match[0].trim();
    const marker = quote.match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) { fence = nextFence(fence, marker); continue; }
    if (fence) continue;
    result.push(...markdownLine(content, start + match.index, start + match.index + match[0].length, ignored));
  }
  return result;
}

/** HTML is parsed as body prose; Markdown retains exact line offsets while omitting fenced code. */
function extractSourcePassages(content: string): SourcePassage[] {
  const start = frontmatterEnd(content);
  if (!htmlDocument(content, start)) return markdownPassages(content, start);
  const masked = content.slice(0, start).replace(/[^\r\n]/g, ' ') + content.slice(start);
  return htmlPassages(content, parsedHtml(masked), start);
}
function copied(passages: SourcePassage[]): SourcePassage[] { return passages.map(passage => ({ ...passage })); }
/** Cache only exact source content; return copies so a caller cannot alter another action's evidence. */
export function sourcePassages(content: string): SourcePassage[] {
  const previous = sourceCache.get(content);
  if (previous) return copied(previous);
  const result = extractSourcePassages(content);
  sourceCache.set(content, result);
  return copied(result);
}
export function semanticHeadingNames(content: string): string[] {
  return sourcePassages(content).filter(passage => passage.headingLevel > 0)
    .map(passage => passage.text.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').trim());
}
/** Retain the opening and distribute the remaining evidence across the complete visible source. */
export function boundedPassages<T>(available: T[], limit = 8): T[] {
  const count = Math.max(0, Math.floor(limit));
  if (available.length <= count || count <= 2) return available.slice(0, count);
  if (count === 3) return [...available.slice(0, 2), available.at(-1)!];
  const remaining = count - 2;
  return [...available.slice(0, 2), ...Array.from({ length: remaining }, (_, index) =>
    available[2 + Math.floor(index * (available.length - 3) / Math.max(1, remaining - 1))])];
}
export function passageCoverage(available: SourcePassage[], analyzed: SourcePassage[]): number {
  const total = available.reduce((length, passage) => length + passage.totalTextLength, 0);
  const checked = analyzed.reduce((length, passage) => length + passage.text.length, 0);
  return Math.min(1, checked / Math.max(1, total));
}
