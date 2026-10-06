import type { Dialog } from './app-model-helpers';

const errorDialogs: Dialog[] = ['block', 'canvas', 'workspace', 'delete-canvas', 'delete-workspace'];

/** These forms show the current failure inside their overlay so it is visible while editing. */
export function dialogShowsError(dialog: Dialog) { return errorDialogs.includes(dialog); }
