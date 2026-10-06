import type { JevQuestion } from '../../jev.js';

const reference = '$jevQuestionText:';
function texts(question: JevQuestion): string[] {
  return [question.instructions, ...Object.values(question.criteria ?? {})];
}
function shared(text: string, counts: Map<string, number>): boolean {
  return text.includes(reference) || (text.length >= 64 && counts.get(text)! > 1);
}
/** Store repeated exact question text once; IDs, types, candidate keys and scoring levels stay unchanged. */
export function compileSharedQuestionTexts(questions: Record<string, JevQuestion>) {
  const owned = JSON.parse(JSON.stringify(questions)) as Record<string, JevQuestion>;
  const counts = new Map<string, number>();
  for (const question of Object.values(owned)) {
    for (const text of texts(question)) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const questionTexts: string[] = []; const indices = new Map<string, number>();
  function compile(text: string): string {
    if (!shared(text, counts)) return text;
    let index = indices.get(text);
    if (index === undefined) { index = questionTexts.length; indices.set(text, index); questionTexts.push(text); }
    return `${reference}${index}`;
  }
  function question(original: JevQuestion): JevQuestion {
    const instructions = compile(original.instructions);
    if (original.type === 'score') return { ...original, instructions, criteria: original.criteria.map(compile) };
    if (!original.criteria) return { ...original, instructions };
    return { ...original, instructions,
      criteria: Object.fromEntries(Object.entries(original.criteria).map(([key, value]) => [key, compile(value)])) };
  }
  return { questionTexts, questions: Object.fromEntries(Object.entries(owned).map(([id, original]) => [id, question(original)])) };
}
