import type { JevActionRequest, JevEvaluation, JevValues } from '../../../shared/jev-types.js';
import { evaluation, judge, proposal, selectedDocuments, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { homeQuestionSet, homeDecision, homeEvidenceQuestionSet } from './home-selection.js';

async function decideHome(context: JevEvaluationContext, request: JevActionRequest, source: JevInputDocument, result: JevEvaluation): Promise<JevValues> {
  const set = homeQuestionSet(context, source, false);
  if (set.canvases.length <= 1) return { status: 'no_change', reason: 'Only one eligible home canvas', options: set.canvases };
  const answers = await judge(context, set.state, set.questions);
  const decision = homeDecision(context, source, answers);
  if (!decision) return { status: 'no_change', reason: 'Current home or insufficient destination support', options: set.canvases, calibration: 1 };
  const evidenceSet = homeEvidenceQuestionSet(source, decision.target);
  const checked = await judge(context, evidenceSet.state, evidenceSet.questions);
  const supported = homeDecision(context, source, { ...answers, ...checked });
  if (!supported?.evidence.length) return { status: 'no_change', reason: 'No exact source passage supports destination', options: set.canvases,
    selectedCanvasId: decision.target.id, decisionConfidences: decision.confidences, calibration: 1 };
  const affected = context.tasks.filter(item => item.canvasId === source.canvasId && item.task.blockIds.includes(source.block.id));
  const candidate = proposal(request, { kind: 'move', canvasId: source.canvasId, blockId: source.block.id, targetCanvasId: supported.target.id },
    [source], `Move to ${supported.target.name}`, `Explicit move preview; ${source.block.links.length} local links and ${affected.length} task attachments need checked migration`,
    supported.evidence, Math.min(...supported.confidences));
  candidate.decisionConfidences = supported.confidences;
  result.proposals.push(candidate);
  return { status: 'proposed', options: set.canvases, selectedCanvasId: supported.target.id, decisionConfidences: supported.confidences, calibration: 1 };
}
export async function homeCanvas(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const decisions = result.result.documents as JevValues;
  for (const source of selectedDocuments(context, request)) decisions[source.block.id] = await decideHome(context, request, source, result);
  result.result.status = result.proposals.length ? 'proposed' : 'current_home_or_insufficient_evidence';
  return result;
}
