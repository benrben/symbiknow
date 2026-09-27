export type ActionKind = 'link' | 'unlink' | 'label' | 'tag' | 'reviewer' | 'loader' | 'merge' | 'merge_safe'
  | 'cross_link' | 'task_update' | 'authorize' | 'verify' | 'stale' | 'steps' | 'conflict' | 'gap' | 'reflected'
  | 'layout' | 'move' | 'route';

export type JevPolicy = Record<ActionKind, { show: number; apply: number }>;

/** 'probability' = Noul yes-probability (or 1 − it); 'confidence' = Choice/Score confidence. Never compare across scales. */
export const policyScale: Record<ActionKind, 'probability' | 'confidence'> = {
  link: 'confidence', unlink: 'probability', label: 'confidence', tag: 'probability', reviewer: 'confidence', loader: 'confidence',
  merge: 'confidence', merge_safe: 'probability', cross_link: 'confidence', task_update: 'probability', authorize: 'probability',
  verify: 'probability', stale: 'probability', steps: 'probability', conflict: 'probability', gap: 'probability', reflected: 'probability',
  layout: 'confidence', move: 'confidence', route: 'confidence',
};

export const defaultJevPolicy: JevPolicy = {
  link: { show: 0.65, apply: 0.75 },
  unlink: { show: 0.80, apply: 0.80 },
  label: { show: 0.65, apply: 0.85 },
  tag: { show: 0.65, apply: 0.85 },
  reviewer: { show: 0.65, apply: 0.85 },
  loader: { show: 0.65, apply: 0.85 },
  merge: { show: 0.70, apply: 1 },
  merge_safe: { show: 0.6, apply: 1 },
  cross_link: { show: 0.70, apply: 0.85 },
  task_update: { show: 0.70, apply: 0.90 },
  authorize: { show: 0, apply: 0.90 },
  verify: { show: 0, apply: 0.70 },
  stale: { show: 0.65, apply: 1 },
  steps: { show: 0.65, apply: 1 },
  conflict: { show: 0.65, apply: 1 },
  gap: { show: 0.7, apply: 1 },
  reflected: { show: 0.65, apply: 1 },
  layout: { show: 0.65, apply: 0.85 },
  move: { show: 0.8, apply: 0.8 },
  route: { show: 0, apply: 0.65 },
};

export function effectiveJevPolicy(overrides?: Partial<JevPolicy>): JevPolicy {
  return Object.fromEntries(Object.entries(defaultJevPolicy).map(([kind, threshold]) =>
    [kind, { ...threshold, ...overrides?.[kind as ActionKind] }])) as JevPolicy;
}
