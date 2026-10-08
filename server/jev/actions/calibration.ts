/** Measured with jev-1.13.0 on the Project Atlas benchmark on 2026-10-07. */
export const decisionBoundaries = {
  topicMembership: 0.3,
  synonym: 0.3,
  duplicateOverlap: 0.5,
  fileGate: 0.4,
  homeGate: 0.3,
  homeMargin: 0.2,
} as const;

/** Map the measured raw boundary to the existing 70% slider scale. */
export function calibrated(raw: number, boundary: number): number {
  if (!Number.isFinite(raw)) return 0;
  const value = raw <= boundary ? 0.7 * (raw / boundary) : 0.7 + 0.3 * (raw - boundary) / (1 - boundary);
  return Math.min(1, Math.max(0, value));
}
