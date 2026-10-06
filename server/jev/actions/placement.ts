import type { JevActionRequest,JevEvaluation } from '../../../shared/jev-types.js';
import { choice } from '../../jev.js';
import {
candidates,confidence,evaluation,evidenceCandidates,exactEvidence,judge,proposal,
selected,selectedDocuments,sourceState,
type JevEvaluationContext
} from './context.js';

export async function homeCanvas(context: JevEvaluationContext, request: JevActionRequest): Promise<JevEvaluation> {
  const result = evaluation({ documents: {} });
  const decisions = result.result.documents as Record<string, unknown>;
  for (const source of selectedDocuments(context, request)) {
    const choices = context.canvases.slice(0, 16).map((canvas, index) => ({ id: `c${index}`, description:
      `${canvas.name}: ${context.documents.filter(document => document.canvasId === canvas.id)
        .slice(0, 3).map(document => document.block.title).join('; ')}` }));
    if (choices.length <= 1) {
      decisions[source.block.id] = { status: 'no_change', reason: 'Only one eligible home canvas', options: choices };
      continue;
    }
    const answers = await judge(context, { source: sourceState(source), currentCanvas: source.canvasId }, {
      canvas: choice('Which allowed canvas purpose/examples best match source?', candidates(choices)),
    });
    const id = selected(answers.canvas, context);
    const target = context.canvases.find((_, index) => `c${index}` === id);
    if (!target || target.id === source.canvasId) {
      decisions[source.block.id] = { status: 'no_change', reason: target ? 'Current canvas matches document purpose' : 'Insufficient destination evidence',
        options: choices, selectionConfidence: confidence(answers.canvas) };
      continue;
    }
    const assessment = await judge(context, { source: sourceState(source), selectedCanvas: {
      id: target.id, name: target.name, description: choices.find(choice => choice.id === id)!.description } }, {
      evidence: choice('Which exact source passage supports the purpose and examples of selectedCanvas as its home?', evidenceCandidates(source)),
    });
    const evidence = exactEvidence(source, assessment.evidence);
    if (!evidence.length) {
      decisions[source.block.id] = { status: 'no_change', reason: 'No exact source passage supports destination', options: choices,
        selectedCanvasId: target.id, selectionConfidence: confidence(answers.canvas) };
      continue;
    }
    const affected = context.tasks.filter(item => item.canvasId === source.canvasId && item.task.blockIds.includes(source.block.id));
    result.proposals.push(proposal(request, { kind: 'move', canvasId: source.canvasId,
      blockId: source.block.id, targetCanvasId: target.id }, [source], `Move to ${target.name}`,
    `Explicit move preview; ${source.block.links.length} local links and ${affected.length} task attachments need checked migration`,
    evidence, confidence(answers.canvas)));
    decisions[source.block.id] = { status: 'proposed', options: choices, selectedCanvasId: target.id,
      selectionConfidence: confidence(answers.canvas) };
  }
  result.result.status = result.proposals.length ? 'proposed' : 'current_home_or_insufficient_evidence';
  return result;
}
