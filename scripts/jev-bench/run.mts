const actions: Record<string, string> = {
  duplicates: 'exp-dup3.mts', links: 'exp-link.mts', profile: 'exp-profile2.mts', label: 'exp-profile2.mts',
  reflex: 'exp-reflex.mts', vocabulary: 'exp-vocab.mts', file: 'exp-placement-evidence.mts',
  home: 'exp-home.mts', search: 'search/e2e.mts',
  'file-production': 'baseline-placement.mts', 'home-production': 'exp-home.mts', 'filing-heldout': 'exp-file-heldout.mts',
  'file-broad-start': 'exp-file-broad-start.mts',
  'file-canonical-queue': 'exp-file-canonical-queue.mts',
};
const [action, label = 'r1', ...extra] = process.argv.slice(2);
if (!actions[action]) throw new Error(`Choose a Jev benchmark action: ${Object.keys(actions).join(', ')}`);
const profilePhase = action === 'profile' ? ['profile'] : action === 'label' ? ['upgraded'] : [];
const placementAction = ['file', 'file-production'].includes(action) ? ['file'] : [];
const argumentsForAction = ['file-broad-start', 'file-canonical-queue'].includes(action)
  ? [extra[0] ?? '--prepare', label, ...extra.slice(1)]
  : [label, ...profilePhase, ...placementAction, ...extra];
process.argv = [...process.argv.slice(0, 2), ...argumentsForAction];
await import(new URL(actions[action], import.meta.url).href);
