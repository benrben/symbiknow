import { choice, type ChoiceAnswer, type JevAnswer } from '../../jev.js';
import { calibrated, decisionBoundaries } from './calibration.js';
import { candidates, outlineState, passages, selectedEvidence, semanticThreshold, type JevEvaluationContext, type JevInputDocument } from './context.js';
import { readablePassage, sectionNames } from './source-passages.js';

const letters = 'ABCDEFGHIJKLMNOP';
function homeCanvases(context: JevEvaluationContext, source: JevInputDocument) {
  const bounded = context.canvases.slice(0, 16);
  if (bounded.some(canvas => canvas.id === source.canvasId)) return bounded;
  const current = context.canvases.find(canvas => canvas.id === source.canvasId);
  return current ? [...bounded.slice(0, 15), current] : bounded;
}
function homeOptions(context: JevEvaluationContext, source: JevInputDocument) {
  return homeCanvases(context, source).map((canvas, index) => ({ option: letters[index], id: canvas.id, name: canvas.name,
    current: canvas.id === source.canvasId,
    documents: context.documents.filter(document => document.canvasId === canvas.id && document.block.id !== source.block.id)
      .slice(0, 6).map(document => ({ title: document.block.title, sections: sectionNames(document.block.content, 4) })) }));
}
function homeSourceState(source: JevInputDocument) {
  const state = outlineState(source, 14);
  return { title: state.title, sections: state.sections, passages: state.passages };
}
export function homeQuestionSet(context: JevEvaluationContext, source: JevInputDocument, includeEvidence = true) {
  const canvases = homeOptions(context, source);
  return { state: { source: includeEvidence ? homeEvidenceSourceState(source) : homeSourceState(source), canvases }, questions: {
    place: choice('Which canvas in `canvases` is where `source` belongs? Judge by the subjects of each canvas\'s documents and their sections. Pick none if no canvas covers the subject of source, even if some words overlap.',
      { ...Object.fromEntries(canvases.map(canvas => [canvas.option, `"${canvas.name}" holds documents on the same subject as source`])), none: 'No canvas holds documents on the subject of source' }),
    gate: choice('Pick the canvas whose documents cover the same subject as `source`. Pick none if no canvas does.',
      { ...Object.fromEntries(canvases.map(canvas => [canvas.option, `Canvas "${canvas.name}" covers the subject of source`])), none: 'No canvas covers the subject of source' }),
    ...(includeEvidence ? { evidence: choice('Which exact source passage supports the purpose and examples of the canvas selected by place as its home? Choose none when no source passage supports that canvas.', homeEvidenceCandidates(source)) } : {}),
  }, canvases };
}
export function homeDecision(context: JevEvaluationContext, source: JevInputDocument, answers: Record<string, JevAnswer>) {
  if (answers.place?.type !== 'choice' || answers.gate?.type !== 'choice') return undefined;
  const ranked = rankedHomes(context, source, answers.place);
  const target = ranked[0];
  if (!movableHome(target, answers.place, answers.gate)) return undefined;
  const current = ranked.find(canvas => canvas.current);
  if (!current) return undefined;
  const confidences = homeConfidences(context, answers.gate, target.probability - current.probability);
  if (!confidences) return undefined;
  return { target, confidences, evidence: homeEvidence(source, answers.evidence) };
}
function rankedHomes(context: JevEvaluationContext, source: JevInputDocument, place: ChoiceAnswer) {
  return homeOptions(context, source).map(canvas => ({ ...canvas, probability: place.probabilities[canvas.option] ?? 0 }))
    .sort((left, right) => right.probability - left.probability);
}
function movableHome(target: ReturnType<typeof rankedHomes>[number] | undefined, place: ChoiceAnswer, gate: ChoiceAnswer): boolean {
  if (!target || target.current || gate.probabilities.none >= .7) return false;
  return place.probabilities.none < target.probability;
}
function homeConfidences(context: JevEvaluationContext, gate: ChoiceAnswer, margin: number) {
  if (margin < decisionBoundaries.homeMargin) return undefined;
  const confidences = [calibrated(1 - gate.probabilities.none, decisionBoundaries.homeGate), calibrated(margin, decisionBoundaries.homeMargin)];
  return confidences.some(confidence => confidence < semanticThreshold(context)) ? undefined : confidences;
}

type HomeEvidenceCanvas = { id: string; name: string; documents: Array<{ title: string; sections: string[] }> };
export function homeEvidenceQuestionSet(source: JevInputDocument, target: HomeEvidenceCanvas) {
  return { state: { source: homeEvidenceSourceState(source), selectedCanvas: { id: target.id, name: target.name,
      documents: target.documents } }, questions: {
    evidence: choice('Which exact source passage establishes the main substantive subject within the topical scope? Judge the broad scope from selectedCanvas.name and document examples, not a requirement to cover every example. Choose none for an incidental overlap or when no supplied passage supports that main subject.', homeEvidenceCandidates(source)),
  } };
}

function homeEvidence(source: JevInputDocument, answer: JevAnswer | undefined) {
  const id = selectedEvidence(answer);
  return passages(source, 16).filter((_, index) => `p${index}` === id);
}

function homeEvidenceSourceState(source: JevInputDocument) {
  return { ...homeSourceState(source), passages: passages(source, 16).map((passage, index) => ({ id: `p${index}`, text: readablePassage(passage.quote) })) };
}
function homeEvidenceCandidates(source: JevInputDocument) {
  return candidates(passages(source, 16).map((passage, index) => ({ id: `p${index}`, description: readablePassage(passage.quote) })));
}
