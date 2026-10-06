import type { JevPassage, JevValues } from '../../../shared/jev-types.js';
import type { JevAnswer } from '../../jev.js';
import { candidates, selectedEvidence, type JevInputDocument } from './context.js';
import { boundedPassages, passageCoverage, readablePassage, sourcePassages } from './source-passages.js';

/** Keep raw offsets while omitting code/diagram bodies and empty Markdown separators. */
export function prosePassages(document: JevInputDocument): JevPassage[] {
  return sourcePassages(document.block.content).map(({ start, end, quote }) => ({ source: document.snapshot, start, end, quote }));
}

/** Bound the filing input while retaining opening context and prose from across the source. */
export function filingPassages(document: JevInputDocument): JevPassage[] {
  return boundedPassages(prosePassages(document));
}
export function filingState(document: JevInputDocument): JevValues {
  const available = sourcePassages(document.block.content);
  const windows = boundedPassages(available);
  return { id: document.block.id, title: document.block.title,
    passages: windows.map((passage, index) => ({ id: `p${index}`, text: passage.text })),
    coverage: passageCoverage(available, windows) };
}
export function filingCandidates(document: JevInputDocument): Record<string, string> {
  return candidates(filingPassages(document).map((passage, index) => ({ id: `p${index}`, description: readablePassage(passage.quote) })));
}
export function filingEvidence(document: JevInputDocument, answer: JevAnswer | undefined): JevPassage[] {
  const id = selectedEvidence(answer);
  return filingPassages(document).filter((_, index) => `p${index}` === id);
}
