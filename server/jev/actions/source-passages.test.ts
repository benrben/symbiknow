import { expect, it } from 'vitest';
import { boundedPassages, passageCoverage, readablePassage, semanticHeadingNames, sourcePassages } from './source-passages.js';

function expectExact(content: string) {
  const passages = sourcePassages(content);
  for (const passage of passages) expect(content.slice(passage.start, passage.end)).toBe(passage.quote);
  return passages;
}

it('reads full HTML visible body text with entities and inline markup while keeping raw evidence exact', () => {
  const content = '\uFEFF---\r\nformat: html\r\ntitle: Hidden metadata\r\n---\r\n<!doctype html><html><head><title>Private metadata</title><style>body{color:red}</style><script>private()</script></head><body><span>Platform · Server</span><h1>Server &amp; <strong>REST API</strong></h1><p>Signed <em>requests</em> retain &#39;exact&#39; evidence.</p><p><strong>One</strong> <em>two</em></p></body></html>';
  const found = expectExact(content);
  expect(found.map(passage => passage.text)).toEqual(['Platform · Server', 'Server & REST API', "Signed requests retain 'exact' evidence.", 'One two']);
  expect(semanticHeadingNames(content)).toEqual(['Server & REST API']);
  expect(found[1].quote).toBe('Server &amp; <strong>REST API');
});

it('omits hidden HTML, comments and code blocks without joining across hidden raw bytes', () => {
  const content = '<!-- page comment --><body><h2>Visible heading</h2><p>Before <span hidden>private code</span> after<!-- private comment --> tail.</p><div hidden>Private text</div><div aria-hidden="true">Also private</div><noscript>Private fallback</noscript><template>Private template</template><pre>Private pre</pre><svg><text>Private diagram</text></svg><p>Visible ending.</p></body>';
  const found = expectExact(content);
  expect(found.map(passage => passage.text)).toEqual(['Visible heading', 'Before', 'after', 'tail.', 'Visible ending.']);
  expect(found.every(passage => !passage.quote.includes('private'))).toBe(true);
  expect(readablePassage('A<!-- secret --> B')).toBe('A B');
  expect(readablePassage('<p><script>secret()</script><pre>hidden</pre>Public</p>')).toBe('Public');
});

it('preserves inline code names and API paths as part of visible paragraph and heading meaning', () => {
  const content = '<body><h1>The <code>/api</code> contract</h1><p>The <code>CanvasStore</code> persists documents.</p><pre><code>secret implementation</code></pre></body>';
  expect(expectExact(content).map(passage => passage.text)).toEqual(['The /api contract', 'The CanvasStore persists documents.']);
  expect(semanticHeadingNames(content)).toEqual(['The /api contract']);
});

it('retains Markdown heading and prose offsets while omitting frontmatter, closed and unclosed fenced code', () => {
  const content = '---\nformat: markdown\n---\n  # Platform ### \nNormal prose.\n~~~html\n<h1>Not a source heading</h1>\n```\nStill code.\n~~~\n## Storage\nPersisted documents.\n```\nUnclosed body';
  expect(expectExact(content).map(passage => passage.quote)).toEqual(['# Platform ###', 'Normal prose.', '## Storage', 'Persisted documents.']);
  expect(semanticHeadingNames(content)).toEqual(['Platform', 'Storage']);
});

it('does not expose embedded multiline HTML scripts or comments from a Markdown document', () => {
  const content = '# Overview\nPublic prose before.\n<script>\nsecretHeading = "Private";\n</script>\nBefore <!--private--> after.\n<style>\n.hidden{display:none}\n</style>\nPublic prose after.';
  expect(expectExact(content).map(passage => passage.text)).toEqual(['# Overview', 'Public prose before.', 'Before', 'after.', 'Public prose after.']);
});

it('bounds exact raw prose length and leaves empty or separator-only documents empty', () => {
  const content = '  ' + 'Long evidence '.repeat(80) + '\n---\n|:---|---:|\n***\n   ';
  const found = expectExact(content);
  expect(found).toHaveLength(1); expect(found[0].quote).toHaveLength(600); expect(found[0].start).toBe(2);
  expect(passageCoverage(found, found)).toBeLessThan(1);
  expect(passageCoverage([], [])).toBe(0);
  expect(sourcePassages('')).toEqual([]); expect(sourcePassages('<html><head><style>only code</style></head><body> </body></html>')).toEqual([]);
  expect(readablePassage('Literal text < comparisons & spaces')).toBe('Literal text < comparisons & spaces');
});

it('distributes bounded semantic evidence across the opening, middle and end with deterministic small limits', () => {
  const source = Array.from({ length: 20 }, (_, index) => index);
  expect(boundedPassages(source)).toEqual([0, 1, 2, 5, 8, 12, 15, 19]);
  expect(boundedPassages(source, 0)).toEqual([]); expect(boundedPassages(source, -4)).toEqual([]);
  expect(boundedPassages(source, 1)).toEqual([0]); expect(boundedPassages(source, 2.9)).toEqual([0, 1]);
  expect(boundedPassages(source, 3)).toEqual([0, 1, 19]); expect(boundedPassages(source, 4)).toEqual([0, 1, 2, 19]);
  expect(boundedPassages(source, 30)).toEqual(source);
});

it('keeps cached evidence isolated from caller mutations, source changes and bounded-cache eviction', () => {
  const content = '# Stable source\nCurrent evidence.';
  const first = sourcePassages(content); first[0].quote = 'Caller corruption'; first.pop();
  expect(sourcePassages(content).map(passage => passage.quote)).toEqual(['# Stable source', 'Current evidence.']);
  const changed = content.replace('Current evidence.', 'Current changed evidence.');
  expect(sourcePassages(changed)[1].text).toBe('Current changed evidence.');
  for (let index = 0; index < 40; index++) sourcePassages(`# Cache source ${index}\nEvidence ${index}.`);
  expect(expectExact(content).map(passage => passage.quote)).toEqual(['# Stable source', 'Current evidence.']);
});
