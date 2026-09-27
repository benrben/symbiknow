import type { AnswerCanvasResult, ChatViewContext } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { groupLabel, groupPath, normalizedGroup } from '../shared/groups';

export type ChatSuggestion = { title: string; detail: string };

function shortTitle(title: string): string {
  return title.length > 42 ? `${title.slice(0, 39).trimEnd()}…` : title;
}

export function chatSuggestions(canvas: CanvasDocument | null, view: ChatViewContext,
  answerCanvas?: AnswerCanvasResult | null): ChatSuggestion[] {
  if (view.viewMode === 'answer' && view.answerFocus?.focusedBlockTitle) {
    const title = shortTitle(view.answerFocus.focusedBlockTitle);
    return [
      { title: `Expand ${title}`, detail: 'Add linked detail to this research block' },
      { title: `What evidence supports ${title}?`, detail: 'Trace and challenge its citations' },
      { title: `Draw the next step from ${title}`, detail: 'Extend this part of the map' },
    ];
  }
  if (view.viewMode === 'answer' && (view.answerFocus?.visibleBlockTitles?.length ?? 0) > 1) return [
    { title: 'How do these visible blocks connect?', detail: 'Explain the structure in view' },
    { title: 'What is missing between these blocks?', detail: 'Extend the visible part of the map' },
    { title: 'Which block needs more evidence?', detail: 'Check the citations' },
  ];
  if (view.viewMode === 'answer' && view.answerFocus?.focusedSourceId) {
    const source = answerCanvas?.sources.find(item => item.blockId === view.answerFocus?.focusedSourceId);
    const name = shortTitle(source?.title ?? canvas?.blocks.find(block => block.id === view.answerFocus?.focusedSourceId)?.title ?? 'this source');
    return [
      { title: `What does ${name} actually support?`, detail: 'Inspect the selected evidence' },
      { title: `What challenges ${name}?`, detail: 'Find counterevidence' },
      { title: `What is missing from ${name}?`, detail: 'Find gaps in this source' },
    ];
  }
  if (view.viewMode === 'answer' && view.answerFocus?.focusedQuestion) return [
    { title: `What supports “${shortTitle(view.answerFocus.focusedQuestion)}”?`, detail: 'Trace this answer to sources' },
    { title: 'Which part of this answer is uncertain?', detail: 'Check the evidence' },
    { title: 'How does this answer change the plan?', detail: 'Connect it to next actions' },
  ];
  if (view.viewMode === 'answer' && (view.answerFocus?.visibleQuestions.length ?? 0) > 1) return [
    { title: 'How do these answers connect?', detail: 'Synthesize the visible answers' },
    { title: 'Do these answers conflict?', detail: 'Check the evidence across turns' },
    { title: 'What is the next useful question?', detail: 'Expand the conversation map' },
  ];
  if (view.viewMode === 'answer' && answerCanvas?.sources.length) return [
    { title: 'Which sources disagree?', detail: 'Check the evidence from this answer' },
    { title: 'What is still unknown?', detail: 'Find gaps in the selected sources' },
    { title: 'What should we do next?', detail: 'Turn these findings into a plan' },
  ];
  const selected = canvas?.blocks.filter(block => view.selectedBlockIds.includes(block.id)) ?? [];
  const focused = selected[0] ?? canvas?.blocks.find(block => block.id === view.readerBlockId || block.id === view.focusBlockId);
  if (selected.length > 1) return [
    { title: 'Where do these documents agree or conflict?', detail: `${selected.length} selected sources` },
    { title: 'What is missing between these documents?', detail: 'Find gaps and unresolved questions' },
    { title: 'What should we do with these findings?', detail: 'Suggest concrete next steps' },
  ];
  if (focused) {
    const title = shortTitle(focused.title);
    if (view.editingBlockId === focused.id) return [
      { title: `Review ${title} for clarity`, detail: 'Check structure and wording' },
      { title: `What is missing from ${title}?`, detail: 'Check gaps against related documents' },
      view.editorHasUnsavedChanges
        ? { title: `Suggest edits for ${title} without saving`, detail: 'Keep your unsaved draft in the editor' }
        : { title: `Edit ${title} for clarity`, detail: 'Update the saved document' },
    ];
    return [
      { title: `Explain ${title} in context`, detail: 'Connect this document to the canvas' },
      { title: `Which documents support or challenge ${title}?`, detail: 'Explore related evidence' },
      { title: `What should happen next for ${title}?`, detail: 'Find useful next actions' },
    ];
  }
  if (view.editorDraft) return [
    { title: 'Review this draft', detail: 'Check structure and wording' },
    { title: 'What is missing from this draft?', detail: 'Find gaps before saving' },
    { title: 'Suggest a clearer version', detail: 'Keep the changes in chat until you choose them' },
  ];
  if (view.searchQuery?.trim()) return [
    { title: `Which sources best answer “${shortTitle(view.searchQuery.trim())}”?`, detail: 'Compare the search results' },
    { title: 'What did this search miss?', detail: 'Look across the workspace' },
    { title: 'Summarize the strongest evidence', detail: 'Open a temporary answer canvas' },
  ];
  if (view.activeGroup) {
    const group = view.activeGroup;
    const count = canvas?.blocks.filter(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped').includes(group)).length ?? 0;
    const name = groupLabel(group);
    return [
      { title: `What matters most in ${name}?`, detail: `${count} document${count === 1 ? '' : 's'} in this group` },
      { title: `Which sources in ${name} disagree?`, detail: 'Compare this part of the canvas' },
      { title: `What is missing from ${name}?`, detail: 'Find gaps and next steps' },
    ];
  }
  if (view.visibleGroups?.length && view.viewMode !== 'documents') {
    const names = view.visibleGroups.slice(0, 2).map(groupLabel).join(' and ');
    return [
      { title: `How do ${names} connect?`, detail: `${view.visibleGroups.length} visible group${view.visibleGroups.length === 1 ? '' : 's'}` },
      { title: 'Which visible group needs attention?', detail: 'Compare the groups in view' },
      { title: 'What is missing between these groups?', detail: 'Find cross-group gaps' },
    ];
  }
  if (answerCanvas?.sources.length) return [
    { title: 'Which sources disagree?', detail: 'Compare evidence from our conversation' },
    { title: 'What is still unknown?', detail: 'Find gaps in our conversation' },
    { title: 'What should we do next?', detail: 'Turn the answers into a plan' },
  ];
  if (!canvas?.blocks.length) return [
    { title: 'Help me plan this canvas', detail: 'Start with goals and sources' },
    { title: 'What should I add first?', detail: 'Get a practical starting point' },
  ];
  return [
    { title: `What matters most in ${shortTitle(canvas.name)}?`, detail: 'See the most useful documents' },
    { title: 'Which documents disagree?', detail: 'Find conflicting claims' },
    { title: 'What is missing or outdated?', detail: 'Spot gaps in this canvas' },
    { title: 'What should the team do next?', detail: 'Use documents and tasks' },
  ];
}
