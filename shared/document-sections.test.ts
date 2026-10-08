import { expect, it } from 'vitest';
import { documentSections, sectionNames } from './document-sections.js';

it('shares ordered Markdown and HTML section names and offsets with bounded action outlines', () => {
  const content = '# Title\n## First\n### Second  topic\n#### Not a section\n<h2 class="topic">Third <em>topic</em></h2>\n<h3>Fourth\n topic</h3>\n<h2> </h2>';
  expect(sectionNames(content)).toEqual(['First', 'Second topic', 'Third topic', 'Fourth topic']);
  expect(sectionNames(content, 2)).toEqual(['First', 'Second topic']);
  expect(sectionNames(content, 0)).toEqual([]);
  expect(documentSections(content)[0]).toEqual({ title: 'First', offset: content.indexOf('## First') });
  expect(sectionNames('No headings')).toEqual([]);
});
