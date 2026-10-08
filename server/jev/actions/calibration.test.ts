import { expect, it } from 'vitest';
import { calibrated, decisionBoundaries } from './calibration.js';

it.each(Object.entries(decisionBoundaries))('maps %s boundaries onto the existing slider scale monotonically', (_name, boundary) => {
  expect(calibrated(0, boundary)).toBe(0);
  expect(calibrated(boundary, boundary)).toBe(0.7);
  expect(calibrated(1, boundary)).toBe(1);
  let previous = 0;
  for (let raw = 0; raw <= 1; raw += 0.01) {
    const value = calibrated(raw, boundary);
    expect(value).toBeGreaterThanOrEqual(previous); previous = value;
  }
  for (const raw of [NaN, Infinity, -Infinity]) expect(calibrated(raw, boundary)).toBe(0);
  expect(calibrated(-1, boundary)).toBe(0); expect(calibrated(2, boundary)).toBe(1);
});
it.each([
  ['topicMembership', 0.38, 0.19], ['synonym', 0.38, 0.17], ['duplicateOverlap', 0.79, 0.22],
  ['fileGate', 0.97, 0.09], ['homeGate', 0.94, 0.10], ['homeMargin', 0.94, 0.19],
] as const)('keeps measured %s positives and negatives on the intended side', (name, positive, negative) => {
  expect(calibrated(positive, decisionBoundaries[name])).toBeGreaterThanOrEqual(0.7);
  expect(calibrated(negative, decisionBoundaries[name])).toBeLessThan(0.7);
});
