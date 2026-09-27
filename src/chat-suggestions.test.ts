import { describe, expect, it } from 'vitest';
import { chatSuggestions } from './chat-suggestions';
import type { CanvasDocument } from '../shared/types';

const canvas: CanvasDocument = { id: 'planning', name: 'Launch planning', workspaceId: 'team', blocks: [
  { id: 'qa', title: 'Mobile QA report', file: 'qa.md', kind: 'markdown', content: '# QA', x: 0, y: 0, width: 300, height: 200, links: [] },
  { id: 'release', title: 'Release plan', file: 'release.md', kind: 'markdown', content: '# Release', x: 400, y: 0, width: 300, height: 200, links: [] },
] };

describe('contextual chat suggestions', () => {
  it('changes suggestions for a focused document and a multi-selection', () => {
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa'] })[0].title).toContain('Mobile QA report');
    expect(chatSuggestions(canvas, { selectedBlockIds: ['qa', 'release'] })[0].title).toContain('these documents');
  });

  it('suggests evidence questions when the answer canvas is visible', () => {
    const suggestions = chatSuggestions(canvas, { selectedBlockIds: [], viewMode: 'answer' }, {
      canvasId: 'planning', query: 'What blocks launch?', selection: 'jev', sources: [
        { canvasId: 'planning', canvasName: 'Launch planning', blockId: 'qa', title: 'Mobile QA report', excerpt: 'Tests failed', relevance: 1 },
      ],
    });
    expect(suggestions.map(item => item.title)).toEqual(['Which sources disagree?', 'What is still unknown?', 'What should we do next?']);
  });

  it('tracks the group and source the user is currently inspecting', () => {
    const grouped = { ...canvas, blocks: canvas.blocks.map(block => ({ ...block, group: block.id === 'qa' ? 'custom:launch/qa' : 'custom:launch' })) };
    expect(chatSuggestions(grouped, { selectedBlockIds: [], viewMode: 'titles', activeGroup: 'custom:launch/qa' })[0].title).toContain('Qa');
    expect(chatSuggestions(grouped, { selectedBlockIds: [], viewMode: 'overview', visibleGroups: ['custom:launch', 'custom:other'] })[0].title)
      .toContain('Launch and Other');
    expect(chatSuggestions(grouped, { selectedBlockIds: [], viewMode: 'answer', answerFocus: {
      level: 'sources', visibleQuestions: [], visibleSourceIds: ['qa'], focusedSourceId: 'qa',
    } })[0].title).toContain('Mobile QA report');
  });
});
