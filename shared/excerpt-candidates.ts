import type { ExcerptFocus, ExcerptLine, ExcerptCandidate } from './excerpt-types.js';
const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const datePattern = new RegExp(
  `\\b(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|${month}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${month}\\.?\\s+\\d{4}|v\\d+(?:\\.\\d+)+|deprecated|as\\s+of)\\b|\\bstatus\\s*:`,
  'iu',
);
const claimPattern = /\p{N}|\b(?:must|should|never|always|defaults?|defaulted)\b/iu;
const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u;

function matchedCandidate(text: string, start: number, matchIndex: number): ExcerptCandidate {
  const leadingSpace = text.length - text.trimStart().length;
  return { text: text.trim(), start: start + matchIndex, matchAt: Math.max(0, matchIndex - leadingSpace) };
}

function stepCandidates(line: ExcerptLine): ExcerptCandidate[] {
  if (!line.stepSection || !listItemPattern.test(line.text)) return [];
  return [{ text: line.text.trim(), start: line.start, matchAt: 0 }];
}

function dateCandidates(line: ExcerptLine): ExcerptCandidate[] {
  const match = datePattern.exec(line.text);
  return match ? [matchedCandidate(line.text, line.start, match.index)] : [];
}

function claimCandidates(line: ExcerptLine): ExcerptCandidate[] {
  const found: ExcerptCandidate[] = []; let cursor = 0;
  for (const sentence of line.text.split(/(?<=[.!?。！？])\s+/u)) {
    const match = claimPattern.exec(sentence);
    const sentenceAt = line.text.indexOf(sentence, cursor);
    cursor = sentenceAt + sentence.length;
    if (match) found.push(matchedCandidate(sentence, line.start + sentenceAt, match.index));
  }
  return found;
}

export function candidates(lines: ExcerptLine[], focus: ExcerptFocus): ExcerptCandidate[] {
  const found: ExcerptCandidate[] = [];
  for (const line of lines) {
    if (line.inCode) continue;
    if (focus === 'steps') { found.push(...stepCandidates(line)); continue; }
    if (focus === 'dates') { found.push(...dateCandidates(line)); continue; }
    found.push(...claimCandidates(line));
  }
  return found;
}
