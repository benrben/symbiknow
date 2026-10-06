import { expect, it } from 'vitest';
import { workAreaChoices, workAreaChoicesForDomains, workAreaDomainChoices, workAreaDomainOptions, workAreaLabel, workAreaOptions } from './work-areas.js';

it('ignores unsupported, legacy-qualified and inherited-property domain strings while preserving other', () => {
  for (const domains of ['', 'unknown', 'engineering/backend', 'constructor', '__proto__', 'toString', []] as const) {
    expect(workAreaChoicesForDomains(domains, 'Field Sales')).toEqual({ other: 'No listed work area fits this document' });
  }
  expect(workAreaChoicesForDomains('workspace', '')).toEqual({ other: 'No listed work area fits this document' });
});

it('keeps caller domain order, skips unknown domains and deduplicates repeated domains without admitting unrelated or custom options', () => {
  const choices = workAreaChoicesForDomains(['people', 'unknown', 'finance', 'people'], 'Field Sales');
  expect(choices).toEqual({ hr: 'People operations and human resources', recruiting: 'Hiring and talent acquisition',
    employee_onboarding: 'Introducing new employees', learning_development: 'Training and professional learning',
    internal_comms: 'Internal company communications', finance: 'Financial planning and analysis',
    accounting: 'Books, reporting, and accounting', budgeting: 'Budgets and spending plans',
    billing: 'Invoices, payments, and billing', tax: 'Tax planning and filing', other: 'No listed work area fits this document' });
  expect(Object.keys(choices)).toEqual(['hr', 'recruiting', 'employee_onboarding', 'learning_development', 'internal_comms',
    'finance', 'accounting', 'budgeting', 'billing', 'tax', 'other']);
});

it('normalizes custom names and keeps the first duplicate while excluding punctuation and built-in keys', () => {
  const name = 'A'.repeat(70);
  const custom = ` Field Sales, field-sales, Frontend, sales, other, !!!, \nQA Escalations\n${name}\n${name} tail`;
  const choices = workAreaChoicesForDomains(['finance', 'workspace'], custom);
  expect(Object.keys(choices)).toEqual(['finance', 'accounting', 'budgeting', 'billing', 'tax', 'other', 'field_sales', 'qa_escalations', 'a'.repeat(60)]);
  expect(choices.field_sales).toBe('Workspace work area: Field Sales');
  expect(choices.qa_escalations).toBe('Workspace work area: QA Escalations');
  expect(choices['a'.repeat(60)]).toBe(`Workspace work area: ${name}`);
  expect(choices).not.toHaveProperty('frontend');
  expect(choices).not.toHaveProperty('sales');
  expect(workAreaChoices(custom)).toMatchObject({ frontend: 'Browser interfaces and frontend code', sales: 'General sales work',
    field_sales: 'Workspace work area: Field Sales', qa_escalations: 'Workspace work area: QA Escalations' });
});

it('retains other and the first accepted custom names at the exact 255-choice native Jev limit', () => {
  const custom = Array.from({ length: 300 }, (_, index) => `Custom area ${index}`).join(',');
  const workspace = workAreaChoicesForDomains('workspace', custom);
  expect(Object.keys(workspace)).toHaveLength(255);
  expect(Object.keys(workspace)[0]).toBe('other');
  expect(workspace.custom_area_253).toBe('Workspace work area: Custom area 253');
  expect(workspace).not.toHaveProperty('custom_area_254');
  const all = workAreaChoices(custom);
  const accepted = 255 - Object.keys(workAreaOptions).length;
  expect(Object.keys(all)).toHaveLength(255);
  expect(all[`custom_area_${accepted - 1}`]).toBe(`Workspace work area: Custom area ${accepted - 1}`);
  expect(all).not.toHaveProperty(`custom_area_${accepted}`);
});

it('returns independent broad choice maps and readable names from saved qualified or legacy labels', () => {
  const choices = workAreaDomainChoices();
  expect(Object.keys(choices)).toEqual(['engineering', 'product_design', 'sales', 'marketing', 'customer', 'operations',
    'finance', 'legal_risk', 'people', 'leadership', 'industry', 'workspace', 'other']);
  expect(choices).toEqual(workAreaDomainOptions);
  choices.workspace = 'Caller-owned description';
  expect(workAreaDomainChoices().workspace).toBe('A custom work area defined in workspace Settings');
  expect(workAreaLabel('product_design/ux_design')).toBe('ux design');
  expect(workAreaLabel('workspace/field_sales')).toBe('field sales');
  expect(workAreaLabel('legacy_custom_area')).toBe('legacy custom area');
  expect(workAreaLabel('')).toBe('');
});
