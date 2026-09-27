import { describe, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../shared/types.js';
import type { JevDecider, JevQuestion } from './jev.js';
import { findDocumentationGaps } from './gaps.js';

function block(id: string, content: string): CanvasBlock {
  return { id, title: `Document ${id}`, content, file: `docs/${id}.md`, kind: 'markdown',
    x: 0, y: 0, width: 400, height: 320, links: [] };
}

describe('documentation gap finder', () => {
  it('asks one question per active document, excludes each document\'s own title from its catalog, and emits evidence-backed cards at the policy threshold', async () => {
    const blocks = [block('setup', '# Setup\nRun the Orion gateway before installing the client.'),
      block('billing', '# Billing\nThe invoice fields are listed here.'),
      { ...block('old', '# Old'), archived: true }];
    const before = structuredClone(blocks);
    const calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      calls.push({ state, questions });
      const [id] = Object.keys(questions);
      return { [id]: { type: 'noul', noul: id === 'd0_gap' ? 0.86 : 0.69 } };
    };
    const items = await findDocumentationGaps({ blocks, apiKey: 'test', decider });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toEqual(['d0_gap']);
    expect(Object.keys(calls[1].questions)).toEqual(['d1_gap']);
    expect(calls[0].state).toMatchObject({ catalog: ['Document billing'], document: { title: 'Document setup' } });
    expect(calls[1].state).toMatchObject({ catalog: ['Document setup'], document: { title: 'Document billing' } });
    const instructions = calls[0].questions.d0_gap.instructions;
    expect(instructions).not.toContain('catalogIndex');
    expect(instructions).not.toContain('Exclude');
    expect(items).toMatchObject([{ category: 'gap', blockIds: ['setup'], confidence: 0.86,
      evidence: [{ questionId: 'd0_gap', answer: '0.86' }] }]);
    expect(items[0].action).toBeUndefined();
    expect(items[0].evidence?.[0].excerpt).toContain('Orion gateway');
    expect(blocks).toEqual(before);
  });

  it('runs bounded concurrency over many documents while keeping deterministic output order', async () => {
    const blocks = Array.from({ length: 13 }, (_, index) => block(`doc-${index}`, `# Guide ${index}\nThis guide depends on the Atlas service.`));
    const seen: string[] = [];
    const decider: JevDecider = async (_key, state, questions) => {
      const [id] = Object.keys(questions);
      seen.push(id);
      const { catalog, document } = state as { catalog: string[]; document: { title: string } };
      expect(catalog).not.toContain(document.title);
      await new Promise(resolve => setTimeout(resolve, id === 'd0_gap' ? 10 : 0));
      return { [id]: { type: 'noul' as const, noul: id === 'd12_gap' ? 0.7 : 0.1 } };
    };
    const items = await findDocumentationGaps({ blocks, apiKey: 'test', decider });
    expect(seen).toHaveLength(13);
    expect(items).toMatchObject([{ blockIds: ['doc-12'], confidence: 0.7 }]);
  });

  it('uses policy.gap.show for the confidence threshold', async () => {
    const blocks = [block('a', '# A\nDepends on Orion.'), block('b', '# B\nDepends on Atlas.')];
    const decider: JevDecider = async (_key, _state, questions) => {
      const [id] = Object.keys(questions);
      return { [id]: { type: 'noul', noul: 0.5 } };
    };
    expect(await findDocumentationGaps({ blocks, apiKey: 'test', decider })).toEqual([]);
    const items = await findDocumentationGaps({ blocks, apiKey: 'test', decider, policy: { gap: { show: 0.4, apply: 1 } } });
    expect(items).toHaveLength(2);
  });

  it('rejects missing Jev answers', async () => {
    const decider = vi.fn(async () => ({}));
    await expect(findDocumentationGaps({ blocks: [block('a', '# A')], apiKey: 'test', decider }))
      .rejects.toMatchObject({ status: 502 });
  });
});
