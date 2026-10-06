import { z } from 'zod';
import { type JevActionRequest,type JevSettings } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { validId } from '../storage-shapes.js';
import { automaticSettings,currentAction,validAutomaticModes } from './automatic-policy.js';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateRequest(value: JevActionRequest): void {
  if (!record(value) || !currentAction(value.action) || !validId(value.canvasId)) throw new ApiError(400, 'Invalid Symbi Reflex action');
  selection(value);
  argumentsForAction(value);
}

function selection(value: JevActionRequest): void {
  if (value.blockIds !== undefined && (!Array.isArray(value.blockIds) || value.blockIds.length > 100 || !value.blockIds.every(validId))) {
    throw new ApiError(400, 'Invalid document selection');
  }
}

function query(value: JevActionRequest): void {
  if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 8000)) throw new ApiError(400, 'Invalid query');
}

function argumentsForAction(value: JevActionRequest): void {
  query(value);
  actionOptions(value);
  operationKey(value);
}
function actionOptions(value: JevActionRequest): void {
  if (value.options !== undefined && (!record(value.options) || JSON.stringify(value.options).length > 1_100_000)) throw new ApiError(400, 'Invalid action arguments');
}
function operationKey(value: JevActionRequest): void {
  if (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length > 200)) throw new ApiError(400, 'Invalid operation key');
}

const personSchema = z.object({ id: z.string().refine(validId), name: z.string().min(1).max(120).refine(name => Boolean(name.trim())), role: z.string().max(200) });

function people(value: JevSettings['people']): void {
  if (!Array.isArray(value) || value.length > 200) throw new ApiError(400, 'Invalid known people');
  for (const person of value) {
    if (!personSchema.safeParse(person).success) throw new ApiError(400, 'Invalid known person');
  }
  if (new Set(value.map(person => person.id)).size !== value.length) throw new ApiError(400, 'Duplicate known person IDs');
}

function settingsPatch(patch: Partial<JevSettings>): void {
  if (!record(patch) || Object.keys(patch).some(key => !['paused', 'externalProcessing', 'modes', 'confidenceThresholds', 'people', 'schedules', 'calibratedActions'].includes(key))) {
    throw new ApiError(400, 'Invalid Symbi Reflex settings');
  }
  processingSettings(patch);
}
function processingSettings(patch: Partial<JevSettings>): void {
  for (const key of ['paused', 'externalProcessing'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new ApiError(400, 'Invalid processing setting');
  }
}

export function updatedJevSettings(previous: JevSettings, patch: Partial<JevSettings>): JevSettings {
  settingsPatch(patch);
  confidenceThresholds(patch.confidenceThresholds);
  actionModes(patch);
  if (patch.modes && !validAutomaticModes(patch.modes)) throw new ApiError(400, 'The retained actions always run automatically');
  automaticScope(patch);
  const next = automaticSettings(mergedSettings(previous, patch));
  confidenceThresholds(next.confidenceThresholds);
  people(next.people);
  return next;
}

function mergedSettings(previous: JevSettings, patch: Partial<JevSettings>): JevSettings {
  const next = { ...previous, ...patch };
  if (patch.confidenceThresholds !== undefined) next.confidenceThresholds = { ...previous.confidenceThresholds, ...patch.confidenceThresholds };
  return next;
}

function confidenceThresholds(value: JevSettings['confidenceThresholds']): void {
  if (value === undefined) return;
  if (!record(value)) throw new ApiError(400, 'Invalid action confidence thresholds');
  for (const [action, threshold] of Object.entries(value)) {
    if (!currentAction(action) || !validThreshold(threshold)) throw new ApiError(400, 'Invalid action confidence threshold');
  }
}

function validThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1;
}
function actionModes(patch: Partial<JevSettings>): void {
  if (patch.modes !== undefined && !record(patch.modes)) throw new ApiError(400, 'Invalid action mode');
}

function automaticScope(patch: Partial<JevSettings>): void {
  if (patch.calibratedActions !== undefined) throw new ApiError(400, 'Action allowlists and digest schedules are no longer supported');
  if (patch.schedules === undefined) return;
  if (!Array.isArray(patch.schedules) || patch.schedules.length > 0) throw new ApiError(400, 'Action allowlists and digest schedules are no longer supported');
}
