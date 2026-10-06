import { jevActions, type JevAction, type JevCurrentAction, type JevSettings, type JevWorkspaceState } from '../../shared/jev-types.js';

import { JEV_QUESTION_VERSION } from './actions/context.js';

export const AUTOMATIC_POLICY_VERSION = 1;
const removedActions = new Set(['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links',
  'attach_doc_to_task', 'assign_owner', 'recall']);

export function currentAction(action: string): boolean {
  return (jevActions as readonly string[]).includes(action);
}

export function automaticModes(): JevSettings['modes'] {
  return Object.fromEntries(jevActions.map(action => [action, 'auto'])) as JevSettings['modes'];
}

export function automaticConfidenceThresholds(): Record<JevCurrentAction, number> {
  return Object.fromEntries(jevActions.map(action => [action, 0.7])) as Record<JevCurrentAction, number>;
}

export function actionConfidenceThreshold(settings: JevSettings, action: JevCurrentAction): number {
  return settings.confidenceThresholds?.[action] ?? 0.7;
}

function retainedThresholds(value: JevSettings['confidenceThresholds']): JevSettings['confidenceThresholds'] {
  if (value === undefined) return automaticConfidenceThresholds();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...automaticConfidenceThresholds(), ...Object.fromEntries(Object.entries(value).filter(([action]) => !removedActions.has(action))) };
}

/** Normalize the current actions without changing saved Pause or processing consent. */
export function automaticSettings(settings: JevSettings): JevSettings {
  const previous = { ...settings };
  delete previous.calibratedActions;
  return { ...previous, automaticPolicyVersion: AUTOMATIC_POLICY_VERSION, modes: automaticModes(), confidenceThresholds: retainedThresholds(settings.confidenceThresholds),
    schedules: [], externalProcessing: settings.externalProcessing,
    paused: settings.paused };
}

export function migrateAutomaticWorkspace(state: JevWorkspaceState): void {
  state.settings = automaticSettings(state.settings);
  for (const job of state.jobs) migrateJob(job);
  for (const proposal of state.proposals) migrateProposal(state, proposal);
}

function outdatedJob(job: JevWorkspaceState['jobs'][number], plan: { version?: number } | undefined): boolean {
  return Boolean(plan && plan.version !== 2) || Boolean(job.questionVersion && job.questionVersion !== JEV_QUESTION_VERSION);
}
function migrateJob(job: JevWorkspaceState['jobs'][number]): void {
  const plan = (job as typeof job & { documentPlan?: { version?: number; activeJob?: typeof job } }).documentPlan;
  if (outdatedJob(job, plan) && ['queued', 'running'].includes(job.state)) job.state = 'cancelled';
  if (pendingRemoved(job.request.action, job.state) || (plan?.activeJob && pendingRemoved(plan.activeJob.request.action, job.state))) {
    job.state = 'cancelled';
  }
}
function migrateProposal(state: JevWorkspaceState, proposal: JevWorkspaceState['proposals'][number]): void {
  if (pendingRemoved(proposal.action, proposal.state) && !protectedHistoricalProposal(state, proposal)) proposal.state = 'dismissed';
}

export function validAutomaticModes(modes: Partial<Record<JevAction, unknown>>): boolean {
  return Object.entries(modes).every(([action, mode]) => currentAction(action) && mode === 'auto');
}

function pendingRemoved(action: string, state: string): boolean {
  return !currentAction(action) && ['queued', 'running', 'pending'].includes(state);
}

function protectedHistoricalProposal(state: JevWorkspaceState, proposal: JevWorkspaceState['proposals'][number]): boolean {
  const receipt = state.receipts.find(item => [`undo:${item.id}`, `origin-migration:${item.id}`].includes(proposal.jobId));
  return Boolean(receipt) && receipt!.action === proposal.action;
}
