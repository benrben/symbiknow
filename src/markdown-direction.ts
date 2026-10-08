import type { Element, Root, RootContent } from 'hast';

const directionalBlocks = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'table', 'th', 'td', 'dt', 'dd']);
const directionalContainers = new Set(['ul', 'ol', 'blockquote', 'table']);
const codeElements = new Set(['code', 'pre']);
const rtlLetter = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;

function textDirection(text: string): 'rtl' | 'ltr' | undefined {
  const letter = text.match(/\p{Letter}/u)?.[0];
  if (!letter) return;
  return rtlLetter.test(letter) ? 'rtl' : 'ltr';
}

function firstDirection(node: RootContent): 'rtl' | 'ltr' | undefined {
  if (node.type === 'text') return textDirection(node.value);
  if (node.type !== 'element') return;
  if (codeElements.has(node.tagName)) return;
  if (node.properties.dir === 'rtl' || node.properties.dir === 'ltr') return node.properties.dir;
  return node.children.map(firstDirection).find(direction => direction !== undefined);
}

function containerDirection(node: Element): 'auto' | 'rtl' | 'ltr' {
  // Native dir=auto ignores descendants that have their own dir, including each list item/cell.
  if (!directionalContainers.has(node.tagName)) return 'auto';
  return node.children.map(firstDirection).find(direction => direction !== undefined) ?? 'auto';
}

function directElement(node: Element, explicitDirection: boolean): void {
  if (node.tagName === 'code' || node.tagName === 'pre') {
    node.properties.dir = 'ltr';
    return;
  }
  if (!explicitDirection && directionalBlocks.has(node.tagName)) node.properties.dir = containerDirection(node);
}

function directMarkdown(node: Root | RootContent, explicitDirection = false): void {
  if (node.type === 'element') {
    explicitDirection ||= node.properties.dir !== undefined;
    directElement(node, explicitDirection);
  }
  if ('children' in node) for (const child of node.children) directMarkdown(child, explicitDirection);
}

/** Let each prose block choose its own direction, while honoring authored HTML directions. */
export function rehypeMarkdownDirection() {
  return (tree: Root) => directMarkdown(tree);
}
