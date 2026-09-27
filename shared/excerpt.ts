export type ExcerptFocus = 'dates' | 'steps' | 'claims';

export type DocumentExcerpt = {
  outline: string;
  head: string;
  tail: string;
  extracts: string;
};

type Line = { text: string; start: number; inCode: boolean; stepSection: boolean };

const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const datePattern = new RegExp(
  `\\b(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|${month}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${month}\\.?\\s+\\d{4}|v\\d+(?:\\.\\d+)+|deprecated|as\\s+of)\\b|\\bstatus\\s*:`,
  'iu',
);
const claimPattern = /\p{N}|\b(?:must|should|never|always|defaults?|defaulted)\b/iu;
const stepHeadingPattern = /\b(?:steps?|install\w*|setup|how)\b|שלב|התקנ|איך|خطو|تثبيت|إعداد/iu;
const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u;
const atxHeadingPattern = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*$/u;
const setextUnderlinePattern = /^ {0,3}(=+|-+)[ \t]*$/u;
const fencePattern = /^ {0,3}(`{3,}|~{3,})/u;

function linesAndOutline(content: string): { lines: Line[]; outline: string } {
  const rows = content.split('\n');
  const lines: Line[] = [];
  const outline: string[] = [];
  const sections: Array<{ level: number; isStep: boolean }> = [];
  let offset = 0;
  let fence: { marker: string; length: number } | undefined;
  let frontmatter = rows[0] === '---' && rows.slice(1, 40).includes('---');

  for (let index = 0; index < rows.length; index += 1) {
    const text = rows[index];
    const start = offset;
    offset += text.length + 1;
    if (frontmatter) {
      lines.push({ text, start, inCode: false, stepSection: false });
      if (index > 0 && text === '---') frontmatter = false;
      continue;
    }

    const fenceMatch = text.match(fencePattern);
    if (fence) {
      lines.push({ text, start, inCode: true, stepSection: false });
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      lines.push({ text, start, inCode: true, stepSection: false });
      continue;
    }

    const atx = text.match(atxHeadingPattern);
    const underline = index + 1 < rows.length ? rows[index + 1].match(setextUnderlinePattern) : null;
    const setext = !atx && text.trim() && underline && !listItemPattern.test(text);
    if (atx || setext) {
      const level = atx ? atx[1].length : underline![1][0] === '=' ? 1 : 2;
      const title = (atx ? atx[2].replace(/[ \t]+#+[ \t]*$/u, '') : text).trim();
      if (title) {
        while (sections.length && sections[sections.length - 1].level >= level) sections.pop();
        sections.push({ level, isStep: stepHeadingPattern.test(title) });
        if (outline.length < 40) outline.push(`${'#'.repeat(level)} ${title}`);
      }
    }
    lines.push({ text, start, inCode: false, stepSection: sections.some(section => section.isStep) });
  }
  return { lines, outline: outline.join('\n') };
}

function candidates(lines: Line[], focus: ExcerptFocus): Array<{ text: string; start: number; matchAt: number }> {
  const found: Array<{ text: string; start: number; matchAt: number }> = [];
  for (const line of lines) {
    if (line.inCode) continue;
    if (focus === 'steps') {
      if (line.stepSection && listItemPattern.test(line.text)) found.push({ text: line.text.trim(), start: line.start, matchAt: 0 });
      continue;
    }
    if (focus === 'dates') {
      const match = datePattern.exec(line.text);
      if (match) {
        const leadingSpace = line.text.length - line.text.trimStart().length;
        found.push({ text: line.text.trim(), start: line.start + match.index, matchAt: Math.max(0, match.index - leadingSpace) });
      }
      continue;
    }
    let cursor = 0;
    for (const sentence of line.text.split(/(?<=[.!?。！？])\s+/u)) {
      const match = claimPattern.exec(sentence);
      const sentenceAt = line.text.indexOf(sentence, cursor);
      cursor = sentenceAt + sentence.length;
      if (match) {
        const leadingSpace = sentence.length - sentence.trimStart().length;
        found.push({ text: sentence.trim(), start: line.start + sentenceAt + match.index, matchAt: Math.max(0, match.index - leadingSpace) });
      }
    }
  }
  return found;
}

function aroundMatch(value: string, matchAt: number, limit: number): string {
  if (value.length <= limit) return value;
  const start = Math.max(0, Math.min(matchAt - Math.floor(limit / 3), value.length - limit));
  return value.slice(start, start + limit).trim();
}

/** Build a compact, question-specific view of a Markdown document. The outline is separate from the character budget. */
export function excerpt(content: string, options: { budget: number; focus?: ExcerptFocus }): DocumentExcerpt {
  if (!Number.isFinite(options.budget) || options.budget < 0) throw new RangeError('Excerpt budget must be a non-negative finite number');
  const source = content.replace(/\r\n?/gu, '\n');
  const budget = Math.floor(options.budget);
  const { lines, outline } = linesAndOutline(source);
  const headLimit = Math.floor(budget * 0.4);
  const tailLimit = Math.floor(budget * 0.2);
  const head = source.slice(0, headLimit);
  const tailStart = Math.max(head.length, source.length - tailLimit);
  const tail = source.slice(tailStart);
  let available = budget - headLimit - tailLimit;
  const extracts: string[] = [];

  if (options.focus && available > 0) {
    for (const candidate of candidates(lines, options.focus)) {
      if (candidate.start < head.length || candidate.start >= tailStart) continue;
      const separator = extracts.length ? 1 : 0;
      if (available <= separator) break;
      const selected = aroundMatch(candidate.text, candidate.matchAt, available - separator);
      if (!selected) continue;
      extracts.push(selected);
      available -= selected.length + separator;
      if (available <= 0) break;
    }
  }
  return { outline, head, tail, extracts: extracts.join('\n') };
}
