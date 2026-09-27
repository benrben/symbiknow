import { describe, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types.js';
import type { JevDecider, JevQuestion } from './jev.js';
import { findCanvasHomes } from './moves.js';

function block(id: string): CanvasBlock {
  return { id, title: `Document ${id}`, content: `# Document ${id}\nProject notes for team ${id}.`,
    file: `docs/${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 320, links: [] };
}

function canvas(id: string, name: string, blocks: CanvasBlock[], workspaceId = 'team'): CanvasDocument {
  return { id, name, workspaceId, blocks };
}

function deciderFor(choices: Record<string, { choice: string; confidence: number }>): JevDecider {
  return async (_key, _state, questions) => Object.fromEntries(Object.keys(questions).map(id => [id, {
    type: 'choice' as const, choice: choices[id]?.choice ?? 'stay', confidence: choices[id]?.confidence ?? 1,
    probabilities: { stay: 1 },
  }]));
}

describe('canvas-home findings', () => {
  it('suggests a split when more than forty percent of documents choose the same destination', async () => {
    const current = canvas('current', 'Product', [block('a'), block('b'), block('c'), block('d'), block('e')]);
    const destination = canvas('engineering', 'Engineering', [block('existing')]);
    const other = canvas('sales', 'Sales', []);
    const before = structuredClone(current);
    const findings = await findCanvasHomes({ canvas: current, canvases: [current, destination, other], apiKey: 'test',
      decider: deciderFor({ d0_home: { choice: 'c0', confidence: 0.9 }, d1_home: { choice: 'c0', confidence: 0.92 },
        d2_home: { choice: 'c0', confidence: 0.88 }, d3_home: { choice: 'c1', confidence: 0.83 } }) });
    expect(findings).toMatchObject([
      { kind: 'split', fromCanvasId: 'current', toCanvasId: 'engineering', blockIds: ['a', 'b', 'c'], confidence: 0.88 },
      { kind: 'move', fromCanvasId: 'current', toCanvasId: 'sales', blockIds: ['d'], confidence: 0.83 },
    ]);
    expect(findings[0].evidence).toHaveLength(3);
    expect(current).toEqual(before);
  });

  it('sends named canvas choices with ten titles, excludes the current canvas, and ignores stay and low-confidence picks', async () => {
    const current = canvas('current', 'Current', [block('a'), block('b'), block('c'), block('d')]);
    const target = canvas('target', 'Target', Array.from({ length: 11 }, (_, index) => block(`target-${index}`)));
    const calls: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
    const base = deciderFor({ d0_home: { choice: 'stay', confidence: 1 }, d1_home: { choice: 'c0', confidence: 0.79 },
      d3_home: { choice: 'c0', confidence: 0.9 } });
    const decider: JevDecider = async (key, state, questions) => { calls.push({ state, questions }); return base(key, state, questions); };
    const findings = await findCanvasHomes({ canvas: current, canvases: [current, target], apiKey: 'test', decider });
    expect(findings).toMatchObject([{ kind: 'move', blockIds: ['d'], toCanvasId: 'target' }]);
    expect(calls).toHaveLength(4);
    const firstQuestion = calls[0].questions.d0_home;
    expect(firstQuestion.type).toBe('choice');
    if (firstQuestion.type !== 'choice') throw new Error('Expected a canvas choice');
    expect(Object.keys(firstQuestion.criteria)).toEqual(['c0', 'stay']);
    expect(firstQuestion.criteria.c0).toContain('Target — Documents: Document target-0');
    expect(firstQuestion.criteria.c0).not.toContain('target-10');
    expect(JSON.stringify(calls[0].state)).not.toContain('target-10');
  });

  it('does not ask Jev when no other canvas exists in the workspace', async () => {
    const current = canvas('current', 'Current', [block('a')]);
    const decider = vi.fn(deciderFor({}));
    expect(await findCanvasHomes({ canvas: current, canvases: [canvas('outside', 'Outside', [], 'other')], apiKey: 'test', decider })).toEqual([]);
    expect(decider).not.toHaveBeenCalled();
  });
});
