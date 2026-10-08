import { strict as assert } from 'node:assert';
import { When, Then } from '@cucumber/cucumber';

const title = 'מסמך בדיקה';
const source = [
  '# שלום עולם', '', 'مرحبا بالعالم', '', 'English paragraph.', '',
  '- פריט ראשון', '- English item', '', '> ציטוט בעברית', '',
  '| כותרת | Value |', '| --- | --- |', '| תוכן | 42 |', '',
  'קוד `const x = 1`', '', '```js', 'const value = "שלום";', '```', '',
  '```', 'plain code', '```', '',
  '<div dir="rtl"><p>Explicit section.</p></div>',
].join('\n');

async function direction(locator, expected) {
  await locator.first().waitFor();
  const actual = await locator.first().evaluate(element => ({ direction: getComputedStyle(element).direction, html: element.outerHTML }));
  assert.equal(actual.direction, expected, JSON.stringify(actual));
}

async function assertProse(region) {
  await direction(region.locator('h1'), 'rtl');
  await direction(region.locator('p', { hasText: 'مرحبا' }), 'rtl');
  await direction(region.locator('p', { hasText: 'English paragraph.' }), 'ltr');
  await direction(region.locator('ul'), 'rtl');
  await direction(region.locator('li', { hasText: 'פריט' }), 'rtl');
  await direction(region.locator('li', { hasText: 'English item' }), 'ltr');
  await direction(region.locator('th', { hasText: 'כותרת' }), 'rtl');
  await direction(region.locator('th', { hasText: 'Value' }), 'ltr');
  await direction(region.locator('p', { hasText: 'Explicit section.' }), 'rtl');
  const quote = await region.locator('blockquote').evaluate(element => {
    const style = getComputedStyle(element);
    return { direction: style.direction, left: style.borderLeftWidth, right: style.borderRightWidth };
  });
  assert.deepEqual(quote, { direction: 'rtl', left: '0px', right: '3px' });
  const code = await region.locator('code').evaluateAll(elements => elements.map(element => getComputedStyle(element).direction));
  assert.ok(code.length >= 3);
  assert.ok(code.every(value => value === 'ltr'));
}

When('I write a mixed direction Markdown document', async function () {
  await this.page.getByRole('button', { name: 'Create note' }).first().click();
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  await editor.getByLabel('Title').fill(title);
  await editor.getByLabel('Markdown source').fill(source);
  await editor.getByRole('button', { name: 'Split', exact: true }).click();
});

Then('the source lines and live preview use the appropriate text directions', async function () {
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  await direction(editor.locator('.cm-line', { hasText: '# שלום' }), 'rtl');
  await direction(editor.locator('.cm-line', { hasText: 'مرحبا' }), 'rtl');
  await direction(editor.locator('.cm-line', { hasText: 'English paragraph.' }), 'ltr');
  await assertProse(editor.getByRole('region', { name: 'Document preview' }));
  assert.deepEqual(this.pageErrors, []);
});

When('I save the mixed direction document and reload', async function () {
  await this.page.getByRole('dialog', { name: 'Document editor' }).getByRole('button', { name: 'Save document' }).click();
  await this.page.getByRole('dialog', { name: 'Document editor' }).waitFor({ state: 'hidden' });
  await this.page.reload({ waitUntil: 'networkidle' });
  const response = await fetch(`${this.baseUrl}/api/canvases/${this.canvasId}`);
  assert.equal(response.status, 200);
  this.rtlDocument = (await response.json()).blocks.find(block => block.title === title);
  assert.equal(this.rtlDocument.content, source);
});

Then('its canvas card and full page retain RTL prose and LTR code', async function () {
  const card = this.page.locator('.canvas-card', { hasText: title });
  await assertProse(card);
  await card.getByRole('button', { name: `Read ${title} full page` }).click();
  const reader = this.page.getByRole('dialog', { name: `${title} full page` });
  await direction(reader.locator('.page-reader__document > h1'), 'rtl');
  await assertProse(reader.locator('.page-reader__content'));
  await reader.getByRole('button', { name: 'Edit document', exact: true }).click();
  const editor = this.page.getByRole('dialog', { name: 'Document editor' });
  assert.equal(await editor.getByLabel('Markdown source').evaluate(element =>
    [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), source);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await this.page.getByRole('button', { name: 'Search documents' }).click();
  await this.page.getByPlaceholder('Search every Markdown file…').fill(title);
  const preview = this.page.getByRole('region', { name: `Preview of ${title}` });
  await assertProse(preview);
  assert.deepEqual(this.pageErrors, []);
});
