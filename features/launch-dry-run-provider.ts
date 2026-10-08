import type { JevAnswer, JevDecider, JevQuestion } from '../server/jev.js';
import { resolveSharedQuestionSources, resolveSharedQuestionTexts } from '../server/jev/actions/question-state-pool.test.helpers.js';

type Source = { id: string; title: string; passages: Array<{ id: string; text: string }> };
type Group = { option: string; key: string; name: string; definition: string };
type Canvas = { option: string; id: string; name: string; current: boolean; documents: Array<{ title: string; sections: string[] }> };
export type LaunchDryRunState = { document?: Source; source?: Source; target?: Source; hypothesis?: string;
  peerSubjects?: Source[] | Record<string, unknown>;
  groups?: Group[]; canvases?: Canvas[]; selectedCanvas?: Pick<Canvas, 'id' | 'name' | 'documents'>;
  selectedGroup?: { name: string; key?: string }; localEvidence?: Array<{ quote: string }>;
  logicalTopicCandidates?: Array<{ name: string; definition?: string }>; labelCandidates?: Array<{ name: string; definition?: string }> };
function body(source?: Source): string { return source?.passages.filter(passage => !/^#/.test(passage.text)).map(passage => passage.text).join('\n') ?? ''; }
/** Synthetic judgments are grounded in body facts, independent of document IDs, tags, and assigned folders. */
function subject(text: string): string | undefined {
  if (/release must be undone|Freeze deploys|Launch date stays/i.test(text)) return 'Release';
  if (/three tiers|final Pro price from the pricing decision|Free: start alone|Pro: for teams/i.test(text)) return 'Pricing';
  if (/SAML login flow|SAML assertion|SSO security review|administrator SSO|Security approval|access tokens with read|Session token not rotated|identity provider metadata rotation|authentication permissions/i.test(text)) return 'Security';
  return undefined;
}
function relation(source: Source, target: Source): string | undefined {
  const left = body(source); const right = body(target);
  if (/final Pro price from the pricing decision/.test(left) && /three tiers/.test(right)) return 'prerequisite';
  if (/Enterprise requires the SSO review/.test(left) && /SAML login flow/.test(right)) return 'prerequisite';
  if (/Launch date stays/.test(left) && /SAML login flow|three tiers|final Pro price|Session token not rotated/.test(right)) return 'prerequisite';
  if (/Launch date stays/.test(left) && /Freeze deploys/.test(right)) return 'related';
  return undefined;
}
function overlap(state: LaunchDryRunState): string {
  const left = body(state.source); const right = body(state.target);
  if (!left || !right) return 'distinct';
  if (left === right) return 'copy';
  if (left.includes(right) || right.includes(left)) return 'version';
  return 'distinct';
}
export function launchQuestionState(wireId: string, wire: Record<string, unknown>) {
  let id = wireId; let state = wire; let prefix: RegExpExecArray | null;
  while ((prefix = /^(\d+)__(.+)$/.exec(id))) { state = (state.questionSets as Record<string, unknown>[])[Number(prefix[1])]; id = prefix[2]; }
  return { id, state: resolveSharedQuestionSources(state, wire.sourceStates) as LaunchDryRunState };
}
function candidateName(id: string, state: LaunchDryRunState): string | undefined {
  const index = Number(id.split('_')[1]);
  if (id.startsWith('logicalTopic')) return state.logicalTopicCandidates?.[index]?.name;
  if (id.startsWith('label_') || id.startsWith('evidence_')) return state.labelCandidates?.[index]?.name;
  return state.selectedGroup?.name;
}
function matchesTopic(text: string, topic: string | undefined): boolean {
  return topic !== undefined && new RegExp(`\\b${topic}\\b`, 'i').test(text);
}
function groupMatches(group: Pick<Group, 'name' | 'key'>, topic: string | undefined): boolean {
  return matchesTopic(`${group.name} ${group.key}`, topic);
}
function canvasMatches(canvas: Pick<Canvas, 'name' | 'documents'>, topic: string | undefined): number {
  return Number(matchesTopic(canvas.name, topic)) * 2 + canvas.documents.filter(document => matchesTopic(`${document.title} ${document.sections.join(' ')}`, topic)).length;
}
export function launchPlacementChoice(state: LaunchDryRunState): string {
  const topic = subject(body(state.document ?? state.source));
  if (state.groups) {
    const matching = state.groups.filter(group => groupMatches(group, topic));
    return (matching.find(group => group.key === 'custom:release/staged') ?? matching[0])?.option ?? 'none';
  }
  const ranked = [...state.canvases ?? []].sort((left, right) => canvasMatches(right, topic) - canvasMatches(left, topic));
  return ranked[0] && canvasMatches(ranked[0], topic) > 0 ? ranked[0].option : 'none';
}
function placementEvidenceFits(state: LaunchDryRunState, topic: string | undefined): boolean {
  if (state.selectedCanvas) return canvasMatches(state.selectedCanvas, topic) > 0;
  return state.selectedGroup !== undefined && matchesTopic(`${state.selectedGroup.name} ${state.selectedGroup.key ?? ''}`, topic);
}
function evidenceChoice(criteria: Record<string, string>, topic: string | undefined): string {
  return Object.keys(criteria).find(key => !/^#/.test(criteria[key]) && subject(criteria[key]) === topic && topic !== undefined) ?? 'none';
}
function referenceEvidence(criteria: Record<string, string>, target: Source): string {
  const text = body(target);
  const reference = /SAML login flow/.test(text) ? /SSO.*review/i
    : /three tiers/.test(text) ? /pricing decision|final Pro price/i
      : /final Pro price/.test(text) ? /pricing page copy/i
        : /Freeze deploys/.test(text) ? /rollback runbook/i : /session token|pen test/i;
  return Object.keys(criteria).find(key => !/^#/.test(criteria[key]) && reference.test(criteria[key])) ?? 'none';
}
function choiceAnswer(question: JevQuestion, selected: string): JevAnswer {
  if (question.type !== 'choice') throw new Error('A bounded choice is required');
  return { type: 'choice', choice: selected, confidence: .98,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) };
}
function binarySupport(id: string, state: LaunchDryRunState, name: string | undefined): boolean {
  if (state.target && state.source) {
    if (state.hypothesis?.includes('same knowledge')) return body(state.source) === body(state.target);
    return Boolean(relation(state.source, state.target));
  }
  const topic = subject(body(state.document ?? state.source));
  if (id === 'independent') return topic !== undefined && Array.isArray(state.peerSubjects)
    && state.peerSubjects.every(peer => subject(body(peer)) !== undefined && subject(body(peer)) !== topic);
  if (id.startsWith('purpose_')) {
    const quote = state.localEvidence?.[Number(id.split('_')[1])]?.quote;
    return name === topic && subject(quote ?? '') === topic && topic !== undefined;
  }
  return name === topic && topic !== undefined;
}
export function launchDryRunAnswer(wireId: string, submitted: JevQuestion, wire: Record<string, unknown>): JevAnswer {
  const question = resolveSharedQuestionTexts(submitted, wire.questionTexts);
  const { id, state } = launchQuestionState(wireId, wire); const name = candidateName(id, state);
  const source = state.document ?? state.source; const topic = subject(body(source));
  if (question.type === 'noul') return { type: 'noul', noul: binarySupport(id, state, name) ? .98 : .01 };
  if (question.type === 'score') return { type: 'score', score: 2, confidence: .98,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === 2)])) };
  if (id === 'place' || id === 'gate') return choiceAnswer(question, launchPlacementChoice(state));
  if (id === 'evidence' && (state.selectedGroup || state.selectedCanvas)) return choiceAnswer(question,
    evidenceChoice(question.criteria, placementEvidenceFits(state, topic) ? topic : undefined));
  if (id === 'group') return choiceAnswer(question, Object.keys(question.criteria).find(key => topic && question.criteria[key].startsWith(topic + ' (')) ?? 'none');
  if (id === 'role') return choiceAnswer(question, Object.keys(question.criteria).find(key => !['none', 'unknown'].includes(key))!);
  if (id === 'overlap') return choiceAnswer(question, overlap(state));
  if (id === 'relation') return choiceAnswer(question, state.source && state.target ? relation(state.source, state.target) ?? 'none' : 'none');
  if (id === 'targetEvidence') return choiceAnswer(question, evidenceChoice(question.criteria, subject(body(state.target))));
  if (id === 'sourceEvidence' && state.source && state.target && relation(state.source, state.target)) return choiceAnswer(question, referenceEvidence(question.criteria, state.target));
  if (id === 'sourceEvidence' || id === 'keyPassage') return choiceAnswer(question, evidenceChoice(question.criteria, topic));
  return choiceAnswer(question, evidenceChoice(question.criteria, name === topic ? topic : undefined));
}

/** Synthetic external-boundary oracle for the checked-in exact launch fixtures; this never calls TypeSafe. */
export const launchDryRunDecider: JevDecider = async (_key, state, questions) => {
  const wire = state as Record<string, unknown>;
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, launchDryRunAnswer(id, question, wire)]));
};

export const launchDryRunProvider: typeof fetch = async (url, options) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected launch fixture provider URL');
  const request = JSON.parse(String(options?.body)) as { state: unknown; questions: Record<string, JevQuestion> };
  return Response.json({ answers: await launchDryRunDecider('synthetic-launch-fixture', request.state, request.questions) });
};
