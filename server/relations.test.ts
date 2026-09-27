import { describe, expect, it } from 'vitest';
import type { CanvasBlock, CanvasTask } from '../shared/types.js';
import type { JevAnswer } from './jev.js';
import { defaultJevPolicy } from '../shared/policy.js';
import { reflectedQuestion, reflectionItem, relationFinding, relationQuestions, supersedesFinding, supersedesQuestion,
  taskDocumentQuestions, taskSuggestions } from './relations.js';

const block = (id: string, purpose?: string): CanvasBlock => ({
  id, title: id, file: `${id}.md`, kind: 'markdown', content: `# ${id}`, x: 0, y: 0, width: 400, height: 300, links: [], purpose,
});
const task = (patch: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 'task-1', title: 'Finish setup', detail: 'Document the setup', status: 'todo', blockIds: [],
  createdBy: 'a', updatedBy: 'a', createdAt: '2026-09-25', updatedAt: '2026-09-25', comments: [], ...patch,
});
const choice = (value: string, confidence = 0.95): JevAnswer => ({
  type: 'choice', choice: value, confidence, probabilities: { [value]: confidence },
});
const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value });

describe('typed relations', () => {
  it('asks one choice over all relation types and builds a typed link', () => {
    const questions = relationQuestions(2);
    const question = questions.p2_rel_ab;
    expect(question.type).toBe('choice');
    if (question.type !== 'choice') throw new Error('Expected a choice question');
    expect(Object.keys(question.criteria)).toEqual([
      'prerequisite', 'implements', 'decision_for', 'supersedes', 'contradicts', 'example_of', 'same_topic', 'related',
    ]);
    expect(questions).toHaveProperty('p2_rel_ba');
    const finding = relationFinding(2, block('a'), block('b'), 'a_to_b', { p2_rel_ab: choice('implements') }, defaultJevPolicy);
    expect(finding?.item.action).toEqual({ type: 'link', fromBlockId: 'a', toBlockId: 'b', relation: 'implements' });
    expect(finding?.conflictItem).toBeUndefined();
  });

  it('adds a conflict card for contradictory links and hides weak picks', () => {
    const finding = relationFinding(0, block('a'), block('b'), 'b_to_a', { p0_rel_ba: choice('contradicts') }, defaultJevPolicy);
    expect(finding?.conflictItem).toMatchObject({ category: 'conflict', blockIds: ['a', 'b'] });
    expect(finding?.item.action).toMatchObject({ fromBlockId: 'b', toBlockId: 'a' });
    expect(relationFinding(0, block('a'), block('b'), 'none', { p0_rel_ab: choice('related') }, defaultJevPolicy)).toBeUndefined();
    expect(relationFinding(0, block('a'), block('b'), 'a_to_b', { p0_rel_ab: choice('related', 0.5) }, defaultJevPolicy)).toBeUndefined();
  });

  it('reads the relation matching the chosen direction, never the other one', () => {
    const answers = { p0_rel_ab: choice('implements'), p0_rel_ba: choice('supersedes') };
    const forward = relationFinding(0, block('a'), block('b'), 'a_to_b', answers, defaultJevPolicy);
    expect(forward?.item.action).toMatchObject({ fromBlockId: 'a', toBlockId: 'b', relation: 'implements' });
    const backward = relationFinding(0, block('a'), block('b'), 'b_to_a', answers, defaultJevPolicy);
    expect(backward?.item.action).toMatchObject({ fromBlockId: 'b', toBlockId: 'a', relation: 'supersedes' });
  });
});

describe('supersedes', () => {
  it('asks only when purposes match or duplicates overlap enough', () => {
    expect(supersedesQuestion(1, block('a', 'guide'), block('b', 'guide'))).toHaveProperty('p1_supersedes');
    expect(supersedesQuestion(1, block('a', 'guide'), block('b', 'report'), 2)).toHaveProperty('p1_supersedes');
    expect(supersedesQuestion(1, block('a', 'guide'), block('b', 'report'), 1)).toEqual({});
  });

  it('marks the older document stale and links newer to older', () => {
    const finding = supersedesFinding(1, block('a'), block('b'), { p1_supersedes: choice('b_supersedes_a') }, defaultJevPolicy);
    expect(finding?.item.category).toBe('supersedes');
    expect(finding?.item.action).toEqual({ type: 'link', fromBlockId: 'b', toBlockId: 'a', relation: 'supersedes' });
    expect(finding?.staleAction).toEqual({ type: 'update', blockId: 'a', patch: { stale: true } });
    expect(supersedesFinding(1, block('a'), block('b'), { p1_supersedes: choice('neither') }, defaultJevPolicy)).toBeUndefined();
  });
});

describe('task and decision relations', () => {
  it('asks task questions only for open tasks and up to five candidate documents', () => {
    const documents = Array.from({ length: 7 }, (_, index) => block(`doc-${index}`));
    expect(Object.keys(taskDocumentQuestions(3, task(), documents))).toEqual([
      't3_d0_about', 't3_d1_about', 't3_d2_about', 't3_d3_about', 't3_d4_about',
    ]);
    expect(taskDocumentQuestions(3, task({ blockIds: ['doc-0'] }), documents)).toHaveProperty('t3_done');
    expect(taskDocumentQuestions(3, task({ status: 'done' }), documents)).toEqual({});
  });

  it('suggests attaching relevant docs and finishing a task when supported', () => {
    const documents = [block('doc-0'), block('doc-1')];
    const suggestions = taskSuggestions(0, task({ blockIds: ['doc-0'] }), documents,
      { t0_d0_about: noul(0.95), t0_d1_about: noul(0.8), t0_done: noul(0.93) }, defaultJevPolicy);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].action).toBeUndefined();
    expect(suggestions[0].proposedAction).toEqual({ type: 'task', taskId: 'task-1', patch: { blockIds: ['doc-0', 'doc-1'] } });
    expect(suggestions[1].action).toEqual({ type: 'task', taskId: 'task-1', patch: { status: 'done' } });
  });

  it('combines multiple document matches so applying the patch keeps all attachments', () => {
    const suggestions = taskSuggestions(0, task(), [block('a'), block('b')],
      { t0_d0_about: noul(0.95), t0_d1_about: noul(0.91) }, defaultJevPolicy);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].action).toEqual({ type: 'task', taskId: 'task-1', patch: { blockIds: ['a', 'b'] } });
  });

  it('flags a decision absent from a neighboring specification', () => {
    const decision = block('decision', 'decision');
    const spec = block('spec', 'specification');
    expect(reflectedQuestion(4, decision, spec)).toHaveProperty('r4_reflected');
    expect(reflectedQuestion(4, block('guide', 'guide'), spec)).toEqual({});
    expect(reflectionItem(4, decision, spec, { r4_reflected: noul(0.2) }, defaultJevPolicy)).toMatchObject({
      category: 'gap', blockIds: ['decision', 'spec'], confidence: 0.8,
    });
    expect(reflectionItem(4, decision, spec, { r4_reflected: noul(0.5) }, defaultJevPolicy)).toBeUndefined();
  });
});
