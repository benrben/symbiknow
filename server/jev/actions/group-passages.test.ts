import { expect, it } from 'vitest';
import type { JevInputDocument } from './context.js';
import { filingCandidates, filingEvidence, filingPassages, filingState, prosePassages } from './group-passages.js';
import { sourceState } from './context.js';

function document(content: string): JevInputDocument {
  return { canvasId: 'canvas', block: { id: 'source', title: 'Source', content, file: 'source.md', kind: 'markdown',
    x: 0, y: 0, width: 400, height: 300, links: [] }, snapshot: { workspaceId: 'workspace', canvasId: 'canvas',
    blockId: 'source', incarnation: 'incarnation', sourceGeneration: 1, contentHash: 'hash', metadataRevision: 1 } };
}
it('preserves exact raw prose offsets and keeps unclosed fenced bodies out of filing evidence', () => {
  const input = document('  # Architecture  \n~~~typescript\nconst privateImplementation = true;\n```\nStill code.\n~~~\n  prose after code  \n```text\nUnclosed code body.');
  expect(prosePassages(input).map(passage => passage.quote)).toEqual(['# Architecture', 'prose after code']);
  for (const passage of prosePassages(input)) expect(input.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
  expect(filingState(input).coverage).toBe(1);
  expect(filingEvidence(input, undefined)).toEqual([]);
  expect(filingEvidence(input, { type: 'choice', choice: 'p1', confidence: 1, probabilities: { p1: 1 } })[0].quote).toBe('prose after code');
});
it('keeps empty and separator-only sources empty without inventing text or coverage', () => {
  const input = document(' \n---\n|:---|---:|\n***');
  expect(filingPassages(input)).toEqual([]);
  expect(filingState(document(''))).toMatchObject({ passages: [], coverage: 0 });
  expect(Object.keys(filingCandidates(input))).toEqual(['none', 'unknown']);
});
it('bounds long prose to eight deterministic exact windows spanning opening, middle and tail', () => {
  const input = document(Array.from({ length: 20 }, (_, index) => '  section ' + index + '  ').join('\n'));
  expect(filingPassages(input).map(passage => passage.quote)).toEqual(['section 0', 'section 1', 'section 2', 'section 5', 'section 8', 'section 12', 'section 15', 'section 19']);
  expect(filingCandidates(input).p7).toBe('section 19');
  expect(filingEvidence(input, { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } })).toEqual([]);
});

it('reads visible HTML prose and headings rather than frontmatter, page metadata, styles or scripts', () => {
  const input = document('---\nformat: html\ntitle: Hidden metadata\n---\n<!doctype html><html><head><title>Page chrome</title><style>body{color:red}</style></head><body>\n<h1>Server &amp; <strong>REST API</strong></h1>\n<p>The server authenticates requests and saves checked documents.</p>\n<script>Secret instructions that must not reach the provider.</script><pre>private code</pre>\n<p>Storage persists revision history.</p></body></html>');
  expect(sourceState(input).passages).toEqual([
    { id: 'p0', text: 'Server & REST API' },
    { id: 'p1', text: 'The server authenticates requests and saves checked documents.' },
    { id: 'p2', text: 'Storage persists revision history.' },
  ]);
  expect(filingCandidates(input).p0).toBe('Server & REST API');
  expect(sourceState(input).coverage).toBe(1); expect(filingState(input).coverage).toBe(1);
  for (const passage of filingPassages(input)) expect(input.block.content.slice(passage.start, passage.end)).toBe(passage.quote);
});
