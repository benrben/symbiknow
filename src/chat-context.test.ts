import { describe, expect, it } from 'vitest';
import { chatScopeOptions, currentViewLabel } from './chat-context';
import type { CanvasDocument } from '../shared/types';

const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [{
  id: 'qa', file: 'qa.md', kind: 'markdown', title: 'QA report', content: 'Tests failed', x: 0, y: 0, width: 300, height: 200, links: [],
}] };

describe('chat context scope', () => {
  it('names the document in view and lets the user switch to the full canvas', () => {
    const view = { selectedBlockIds: ['qa'], viewMode: 'documents' as const, activeGroup: 'area:launch' };
    expect(currentViewLabel(canvas, view)).toBe('QA report');
    const options = chatScopeOptions(canvas, view, []);
    expect(options.map(option => option.label)).toEqual(['Current view', 'Whole canvas', 'Selected documents']);
    expect(options[1].context).toMatchObject({ selectedBlockIds: [], viewMode: 'overview' });
    expect(options[2].context.selectedBlockIds).toEqual(['qa']);
  });

  it('offers the session research scope after leaving its canvas', () => {
    const options = chatScopeOptions(canvas, { selectedBlockIds: [] }, [{
      id: 1, query: 'Map launch risks', answer: '', status: 'complete', sources: [{
        canvasId: 'planning', canvasName: 'Planning', blockId: 'qa', title: 'QA report', excerpt: 'Tests failed', relevance: 1,
      }],
    }]);
    expect(options.at(-1)?.context).toMatchObject({ viewMode: 'answer', answerSourceIds: ['qa'] });
  });
});
