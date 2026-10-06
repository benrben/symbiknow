import type { ExcerptLine } from './excerpt-types.js';

const stepHeadingPattern = /\b(?:steps?|install\w*|setup|how)\b|שלב|התקנ|איך|خطو|تثبيت|إعداد/iu;
const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u;
const atxHeadingPattern = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*$/u;
const setextUnderlinePattern = /^ {0,3}(=+|-+)[ \t]*$/u;
const fencePattern = /^ {0,3}(`{3,}|~{3,})/u;
type Fence = { marker: string; length: number };
type Section = { level: number; isStep: boolean };
type ScanState = { frontmatter: boolean; fence?: Fence; sections: Section[]; outline: string[] };

function closesFence(text: string, match: RegExpMatchArray | null, fence: Fence) {
  if (!match) return false;
  return match[1][0] === fence.marker && match[1].length >= fence.length
    && text.slice(match[0].length).trim() === '';
}

function frontmatterEnd(index: number, text: string) { return index > 0 && text === '---'; }

function specialLine(text: string, index: number, state: ScanState): boolean | undefined {
  if (state.frontmatter) {
    if (frontmatterEnd(index, text)) state.frontmatter = false;
    return false;
  }
  const match = text.match(fencePattern);
  if (state.fence) {
    if (closesFence(text, match, state.fence)) state.fence = undefined;
    return true;
  }
  if (match) { state.fence = { marker: match[1][0], length: match[1].length }; return true; }
  return undefined;
}

function setextHeading(text: string, next: string | undefined) {
  const underline = next?.match(setextUnderlinePattern);
  if (!text.trim() || !underline || listItemPattern.test(text)) return undefined;
  return { level: underline[1][0] === '=' ? 1 : 2, title: text.trim() };
}

function headingAt(rows: string[], index: number) {
  const text = rows[index]; const atx = text.match(atxHeadingPattern);
  if (!atx) return setextHeading(text, rows[index + 1]);
  return { level: atx[1].length, title: atx[2].replace(/[ \t]+#+[ \t]*$/u, '').trim() };
}

function addHeading(heading: { level: number; title: string } | undefined, state: ScanState) {
  if (!heading?.title) return;
  while (state.sections.length && state.sections[state.sections.length - 1].level >= heading.level) state.sections.pop();
  state.sections.push({ level: heading.level, isStep: stepHeadingPattern.test(heading.title) });
  if (state.outline.length < 40) state.outline.push(`${'#'.repeat(heading.level)} ${heading.title}`);
}

export function linesAndOutline(content: string): { lines: ExcerptLine[]; outline: string } {
  const rows = content.split('\n'); const lines: ExcerptLine[] = [];
  const state: ScanState = { frontmatter: rows[0] === '---' && rows.slice(1, 40).includes('---'), sections: [], outline: [] };
  let offset = 0;
  for (let index = 0; index < rows.length; index++) {
    const text = rows[index]; const start = offset; offset += text.length + 1;
    const inCode = specialLine(text, index, state);
    if (inCode !== undefined) { lines.push({ text, start, inCode, stepSection: false }); continue; }
    addHeading(headingAt(rows, index), state);
    lines.push({ text, start, inCode: false, stepSection: state.sections.some(section => section.isStep) });
  }
  return { lines, outline: state.outline.join('\n') };
}
