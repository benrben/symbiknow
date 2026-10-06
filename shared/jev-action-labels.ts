import type { JevAction } from './jev-types.js';

/** Shared product language for commands, settings, and activity. */
export const jevActionLabels: Partial<Record<JevAction, string>> = {
  profile: 'Understand documents',
  file: 'Organize into groups',
  label: 'Suggest labels',
  suggest_home_canvas: 'Find a home canvas',
  link: 'Find useful connections',
  flag_duplicate: 'Compare possible duplicates',
  flag_conflict: 'Find conflicting claims',
  recheck_links: 'Recheck connections',
  vocab_lifecycle: 'Manage groups and labels',
  score_quality: 'Review document quality',
  attach_doc_to_task: 'Connect documents to work',
  assign_owner: 'Suggest responsibility',
  recall: 'Find supporting knowledge',
};
