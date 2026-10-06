import { JEV_QUESTION_VERSION } from './actions/context.js';
import { expect, it } from 'vitest';
import { jevActions, type JevActionRequest } from '../../shared/jev-types.js';
import { actionConfidenceThreshold, automaticConfidenceThresholds, automaticModes, automaticSettings, currentAction,
  migrateAutomaticWorkspace, validAutomaticModes } from './automatic-policy.js';
import { updatedJevSettings, validateRequest } from './configuration.js';
import { emptyJevWorkspace } from './workspace.js';

const retired = ['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall', 'set_headline', 'set_freshness', 'flag_sensitive', 'order_reading', 'suggest_archive',
  'mark_supersedes', 'flag_gap', 'create_task_from_line', 'suggest_task_done', 'prioritize', 'where_to_put',
  'route_chat', 'digest', 'review_agent_edit'];

it('exposes exactly the selected actions and makes each automatic without enabling requests', () => {
  expect(jevActions).toEqual(['profile', 'file', 'label', 'suggest_home_canvas', 'link', 'flag_duplicate']);
  const state = emptyJevWorkspace();
  expect(state.settings).toMatchObject({ paused: false, externalProcessing: true, modes: automaticModes(), schedules: [], confidenceThresholds: automaticConfidenceThresholds() });
  expect(validAutomaticModes(state.settings.modes)).toBe(true);
  expect(currentAction('profile')).toBe(true);
  expect(currentAction('invented')).toBe(false);
});

it.each(retired)('rejects removed action %s at the action request boundary', action => {
  expect(() => validateRequest({ action, canvasId: 'canvas' } as JevActionRequest)).toThrow('Invalid Symbi Reflex action');
});

it('migrates old modes, allowlists, schedules and pending removed actions while preserving saved receipts', () => {
  const state = emptyJevWorkspace(); delete state.settings.automaticPolicyVersion;
  state.settings.externalProcessing = false; state.settings.paused = true;
  state.settings.modes.profile = 'suggest'; state.settings.calibratedActions = ['profile'];
  state.settings.schedules = [{ id: 'old-digest', canvasIds: ['canvas'], timezone: 'UTC', time: '09:00', enabled: true }];
  state.jobs = [{ id: 'removed', request: { action: 'digest', canvasId: 'canvas' }, state: 'queued' },
    { id: 'history', request: { action: 'set_headline', canvasId: 'canvas' }, state: 'completed' }] as typeof state.jobs;
  state.proposals = [{ id: 'removed', action: 'set_headline', state: 'pending' },
    { id: 'saved', action: 'set_headline', state: 'applied' }] as typeof state.proposals;
  migrateAutomaticWorkspace(state);
  expect(state.settings).toMatchObject({ paused: true, externalProcessing: false, modes: automaticModes(), schedules: [] });
  expect(state.settings.calibratedActions).toBeUndefined();
  expect(state.jobs.map(job => job.state)).toEqual(['cancelled', 'completed']);
  expect(state.proposals.map(proposal => proposal.state)).toEqual(['dismissed', 'applied']);
  const unchanged = structuredClone(state); migrateAutomaticWorkspace(state); expect(state).toEqual(unchanged);
});

it('honors explicit later pause and withdrawal and preserves configured people', () => {
  const state = emptyJevWorkspace();
  const next = updatedJevSettings(state.settings, { paused: true, externalProcessing: false,
    people: [{ id: 'alice', name: 'Alice', role: 'Owner' }], modes: { profile: 'auto' } as never });
  expect(automaticSettings(next)).toEqual(next);
  expect(next).toMatchObject({ paused: true, externalProcessing: false, people: [{ id: 'alice' }] });
});

it('defaults each action to 70 percent while preserving explicit cutoffs through migration and partial updates', () => {
  const state = emptyJevWorkspace(); delete state.settings.automaticPolicyVersion;
  state.settings.confidenceThresholds = { file: 0.85, flag_duplicate: 1 };
  migrateAutomaticWorkspace(state);
  expect(state.settings.confidenceThresholds).toEqual({ ...automaticConfidenceThresholds(), file: 0.85, flag_duplicate: 1 });
  const next = updatedJevSettings(state.settings, { confidenceThresholds: { label: 0.5 } });
  expect(next.confidenceThresholds).toEqual({ ...automaticConfidenceThresholds(), file: 0.85, flag_duplicate: 1, label: 0.5 });
  expect(state.settings.confidenceThresholds?.label).toBe(0.7);
  expect(updatedJevSettings(next, { confidenceThresholds: {} })).toEqual(next);
  expect(automaticSettings(next)).toEqual(next);
  expect(next.modes).toEqual(automaticModes());
  delete state.settings.confidenceThresholds;
  expect(automaticSettings(state.settings).confidenceThresholds).toEqual(automaticConfidenceThresholds());
});

it('leaves malformed saved threshold shapes visible for the settings validator to reject', () => {
  const settings = emptyJevWorkspace().settings;
  expect(automaticSettings({ ...settings, confidenceThresholds: null } as never).confidenceThresholds).toBeNull();
  expect(automaticSettings({ ...settings, confidenceThresholds: [] } as never).confidenceThresholds).toEqual([]);
});

it('reads explicit action confidence and falls back to the unchanged default', () => {
  const settings = emptyJevWorkspace().settings;
  expect(actionConfidenceThreshold({ ...settings, confidenceThresholds: { file: .91 } }, 'file')).toBe(.91);
  expect(actionConfidenceThreshold({ ...settings, confidenceThresholds: {} }, 'file')).toBe(.7);
});

it('rejects malformed confidence maps, retired actions, and nonfinite or out-of-range cutoffs', () => {
  const previous = emptyJevWorkspace().settings;
  for (const confidenceThresholds of [null, [], false, '0.8', 0.8, { invented: 0.8 }, { digest: 0.8 },
    ...[null, undefined, false, '0.8', NaN, Infinity, -Infinity, 0.4999, 1.0001].map(profile => ({ profile }))]) {
    expect(() => updatedJevSettings(previous, { confidenceThresholds } as never)).toThrowError(expect.objectContaining({ status: 400 }));
  }
  for (const confidenceThresholds of [null, [], false, '0.8', 0.8, { profile: 2 }]) {
    const corrupt = { ...previous, confidenceThresholds } as never;
    expect(() => updatedJevSettings(automaticSettings(corrupt), {})).toThrowError(expect.objectContaining({ status: 400 }));
  }
  expect(previous).toEqual(emptyJevWorkspace().settings);
});

it.each(['off', 'shadow', 'suggest', 'unknown'])('rejects nonautomatic mode %s instead of requiring user action', mode => {
  expect(() => updatedJevSettings(emptyJevWorkspace().settings, { modes: { profile: mode } as never })).toThrow('always run automatically');
});

it('rejects retired grants and schedules and unsupported selectors', () => {
  expect(validAutomaticModes({ digest: 'auto' })).toBe(false);
  expect(() => updatedJevSettings(emptyJevWorkspace().settings, { calibratedActions: ['profile'] })).toThrow('no longer supported');
  expect(() => updatedJevSettings(emptyJevWorkspace().settings, { schedules: [{ id: 'digest' }] as never })).toThrow('no longer supported');
  expect(() => updatedJevSettings(emptyJevWorkspace().settings, { modes: null } as never)).toThrow('Invalid action mode');
});

it('accepts an empty retired schedule collection without reintroducing scheduled actions', () => {
  const state = emptyJevWorkspace();
  expect(updatedJevSettings(state.settings, { schedules: [] })).toEqual(state.settings);
});

it.each(['undo', 'origin-migration'])('keeps only receipt-backed historical %s recovery while retiring unrelated pending actions', prefix => {
  const state = emptyJevWorkspace();
  state.receipts = [{ id: 'saved', action: 'set_headline' }] as typeof state.receipts;
  state.proposals = [{ id: 'inverse', action: 'set_headline', state: 'pending', jobId: `${prefix}:saved` },
    { id: 'forged', action: 'set_headline', state: 'pending', jobId: `${prefix}:missing` },
    { id: 'wrong-action', action: 'digest', state: 'pending', jobId: `${prefix}:saved` }] as typeof state.proposals;
  migrateAutomaticWorkspace(state);
  expect(state.proposals.map(proposal => proposal.state)).toEqual(['pending', 'dismissed', 'dismissed']);
});


it.each(['vocab_lifecycle', 'score_quality', 'flag_conflict', 'recheck_links', 'attach_doc_to_task', 'assign_owner', 'recall'] as const)(
  'retires queued %s and its settings while preserving consent, history and current thresholds', action => {
    const state = emptyJevWorkspace(); delete state.settings.automaticPolicyVersion;
    state.settings.paused = true; state.settings.externalProcessing = false;
    state.settings.modes[action] = 'auto';
    state.settings.confidenceThresholds = { ...state.settings.confidenceThresholds, file: 0.91, [action]: 0.8 };
    state.jobs = [{ id: 'queued', request: { action, canvasId: 'canvas' }, state: 'queued' },
      { id: 'history', request: { action, canvasId: 'canvas' }, state: 'completed' },
      { id: 'root', request: { action: 'profile', canvasId: 'canvas' }, state: 'running',
        documentPlan: { activeJob: { request: { action } } } }] as typeof state.jobs;
    state.proposals = [{ id: 'pending', action, state: 'pending' }, { id: 'applied', action, state: 'applied' }] as typeof state.proposals;
    state.receipts = [{ id: 'saved', action, state: 'applied' }] as typeof state.receipts;
    const history = structuredClone(state.receipts);
    migrateAutomaticWorkspace(state);
    expect(state.settings).toMatchObject({ paused: true, externalProcessing: false, confidenceThresholds: { file: 0.91 } });
    expect(Object.keys(state.settings.modes).sort()).toEqual([...jevActions].sort());
    expect(Object.keys(state.settings.confidenceThresholds!).sort()).toEqual([...jevActions].sort());
    expect(state.jobs.map(job => job.state)).toEqual(['cancelled', 'completed', 'cancelled']);
    expect(state.proposals.map(proposal => proposal.state)).toEqual(['dismissed', 'applied']);
    expect(state.receipts).toEqual(history);
    expect(() => updatedJevSettings(state.settings, { confidenceThresholds: { [action]: 0.8 } })).toThrow('Invalid action confidence threshold');
    expect(() => updatedJevSettings(state.settings, { modes: { [action]: 'auto' } as never })).toThrow('always run automatically');
  });

it.each(['queued', 'running'] as const)('cancels outdated %s document plans and question programs while preserving current work', status => {
  const state = emptyJevWorkspace();
  state.settings.paused = true; state.settings.externalProcessing = false;
  state.settings.confidenceThresholds = { file: .91, profile: .86 };
  const job = (id: string, questionVersion: string, version?: number) => ({ id, questionVersion,
    request: { action: 'profile' as const, canvasId: 'canvas' }, state: status,
    sources: [], proposalIds: [], createdAt: '2026-10-01', updatedAt: '2026-10-02',
    ...(version === undefined ? {} : { documentPlan: { version, completedActions: ['profile'] } }) });
  state.jobs = [job('old-plan', JEV_QUESTION_VERSION, 1), job('old-questions', 'previous-question-program', 2),
    job('old-ordinary-job', 'previous-question-program'), job('current-plan', JEV_QUESTION_VERSION, 2),
    job('current-ordinary-job', JEV_QUESTION_VERSION)];
  migrateAutomaticWorkspace(state);
  expect(state.jobs.map(item => [item.id, item.state])).toEqual([
    ['old-plan', 'cancelled'], ['old-questions', 'cancelled'], ['old-ordinary-job', 'cancelled'],
    ['current-plan', status], ['current-ordinary-job', status],
  ]);
  expect(state.settings).toMatchObject({ paused: true, externalProcessing: false, confidenceThresholds: { file: .91, profile: .86 } });
  const migrated = structuredClone(state); migrateAutomaticWorkspace(state); expect(state).toEqual(migrated);
});

it.each(['completed', 'failed', 'cancelled'] as const)('preserves historical %s document outcomes, receipts and Undo when the question program advances', status => {
  const state = emptyJevWorkspace(); state.settings.paused = true; state.settings.externalProcessing = false;
  const historicalJob = { id: 'historical-plan', questionVersion: 'previous-question-program',
    request: { action: 'profile' as const, canvasId: 'canvas' }, state: status, result: { retained: 'Exact historical result' },
    sources: [], proposalIds: ['saved-proposal'], createdAt: '2026-10-01', updatedAt: '2026-10-02',
    documentPlan: { version: 1, completedActions: ['profile', 'file'] } };
  state.jobs = [historicalJob];
  state.receipts = [{ id: 'saved', proposalId: 'saved-proposal', createdAt: '2026-10-01', actor: 'owner', sourcesAfter: [],
    action: 'recall', state: 'applied', before: { kind: 'derived', blockId: 'source', values: { previous: true } },
    after: { kind: 'derived', blockId: 'source', values: { retained: 'Historical evidence' } } }];
  state.proposals = [{ id: 'inverse', action: 'recall', state: 'pending', jobId: 'undo:saved' }] as typeof state.proposals;
  state.profiles['canvas:source'] = { logicalIndex: { version: 1, topics: [] }, questionVersion: 'previous-question-program' };
  const retained = structuredClone({ jobs: state.jobs, receipts: state.receipts, proposals: state.proposals, profiles: state.profiles });
  migrateAutomaticWorkspace(state);
  expect({ jobs: state.jobs, receipts: state.receipts, proposals: state.proposals, profiles: state.profiles }).toEqual(retained);
  expect(state.settings).toMatchObject({ paused: true, externalProcessing: false });
});
