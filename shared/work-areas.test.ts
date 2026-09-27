import { describe, expect, it } from 'vitest';
import { workAreaChoices, workAreaChoicesForDomains, workAreaDomainChoices, workAreaDomains, workAreaLabel, workAreaOptions } from './work-areas.js';

describe('Jev work-area choices', () => {
  it('covers at least 100 distinct project and business work areas', () => {
    const keys = Object.keys(workAreaOptions);
    expect(keys.length).toBeGreaterThanOrEqual(100);
    expect(keys.length).toBeLessThanOrEqual(255);
    expect(keys).toEqual(expect.arrayContaining([
      'developers', 'frontend', 'project_planning', 'sales', 'customer_success', 'finance', 'other',
    ]));
  });

  it('accepts custom names without exceeding Jev’s 255-option limit', () => {
    const custom = Array.from({ length: 200 }, (_, index) => `Custom area ${index}`).join(',');
    const choices = workAreaChoices(custom);
    expect(Object.keys(choices)).toHaveLength(255);
    expect(choices).toHaveProperty('custom_area_0', 'Workspace work area: Custom area 0');
    expect(choices).toHaveProperty('other');
  });

  it('normalizes duplicates and displays saved labels in readable form', () => {
    const choices = workAreaChoices('Field Sales, field-sales, Project Planning, !');
    expect(choices).toHaveProperty('field_sales', 'Workspace work area: Field Sales');
    expect(choices).toHaveProperty('project_planning', workAreaOptions.project_planning);
    expect(workAreaLabel('field_sales')).toBe('field sales');
  });

  it('assigns every built-in area to exactly one of the eleven subject domains', () => {
    expect(Object.keys(workAreaDomains)).toHaveLength(13);
    const areas = Object.values(workAreaDomains).flat();
    expect(new Set(areas).size).toBe(areas.length);
    expect(areas.sort()).toEqual(Object.keys(workAreaOptions).filter(key => key !== 'other').sort());
    expect(Object.keys(workAreaDomainChoices())).toEqual(Object.keys(workAreaDomains));
  });

  it('offers only selected domain areas in the second choice', () => {
    const choices = workAreaChoicesForDomains('engineering', 'Field Sales');
    expect(choices).toHaveProperty('backend', workAreaOptions.backend);
    expect(choices).toHaveProperty('other', workAreaOptions.other);
    expect(choices).not.toHaveProperty('sales');
    expect(choices).not.toHaveProperty('field_sales');
    const topTwo = workAreaChoicesForDomains(['engineering', 'sales'], 'Field Sales');
    expect(topTwo).toHaveProperty('backend');
    expect(topTwo).toHaveProperty('sales');
    expect(topTwo).not.toHaveProperty('marketing');
  });

  it('offers workspace custom areas with other while keeping the 255-choice cap per domain', () => {
    const custom = Array.from({ length: 300 }, (_, index) => `Custom area ${index}`).join(',');
    const choices = workAreaChoicesForDomains('workspace', custom);
    expect(Object.keys(choices)).toHaveLength(255);
    expect(choices).toHaveProperty('custom_area_0', 'Workspace work area: Custom area 0');
    expect(choices).toHaveProperty('other');
    expect(choices).not.toHaveProperty('backend');
    expect(workAreaChoicesForDomains('other', custom)).toEqual({ other: workAreaOptions.other });
  });
});
