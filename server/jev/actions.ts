import type { JevAction, JevActionRequest, JevCurrentAction, JevEvaluation } from '../../shared/jev-types.js';
import { ApiError } from '../errors.js';
import { type JevEvaluationContext, type JevEvaluator } from './actions/context.js';
import { file, label, profile } from './actions/profile.js';
import { link, pairFinding } from './actions/graph.js';
import { homeCanvas } from './actions/placement.js';
import { validateActionOptions } from './actions/options.js';

export type { JevEvaluationContext, JevInputDocument } from './actions/context.js';
export { JEV_QUESTION_VERSION } from './actions/context.js';
export const jevActionEvaluators: Partial<Record<JevAction, JevEvaluator>> = {
  profile, file, label, suggest_home_canvas: homeCanvas, link,
  flag_duplicate: pairFinding,
};
export async function evaluateJevAction(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  if (!context.canvases.some(canvas => canvas.id === request.canvasId)) throw new ApiError(404, 'Requested canvas is unavailable');
  const evaluator = jevActionEvaluators[request.action];
  if (!evaluator) throw new ApiError(400, 'Unknown Symbi Reflex action');
  validateActionOptions(request);
  const canvasIds = new Set(context.canvases.map(canvas => canvas.id));
  const documents = context.documents.filter(document => document.snapshot.workspaceId === context.workspaceId)
    .filter(document => canvasIds.has(document.canvasId))
    .filter(document => !document.block.processingExcluded);
  const identities = new Set(documents.map(document => `${document.canvasId}:${document.block.id}`));
  const vocabulary = context.vocabulary.filter(term => term.members.every(member => identities.has(`${member.canvasId}:${member.blockId}`)));
  const tasks = context.tasks.filter(item => canvasIds.has(item.canvasId));
  const confidenceThreshold = context.settings.confidenceThresholds?.[request.action as JevCurrentAction] ?? 0.7;
  return evaluator({ ...context, documents, vocabulary, tasks, confidenceThreshold }, request);
}
