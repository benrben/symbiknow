import { firstSuggestions } from './chat-suggestion-rules';
import { shortSuggestionTitle } from './chat-suggestion-titles';
import type { ChatSuggestion, SuggestionContext } from './chat-suggestion-types';

export function answerSuggestions(context: SuggestionContext): ChatSuggestion[] | null {
  if (context.view.viewMode !== 'answer') return null;
  return firstSuggestions(context, [focusedBlockSuggestions, visibleBlockSuggestions, focusedSourceSuggestions,
    focusedQuestionSuggestions, visibleQuestionSuggestions, answerSourceSuggestions]);
}

function focusedBlockSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  if (!view.answerFocus?.focusedBlockTitle) return null;
  const title = shortSuggestionTitle(view.answerFocus.focusedBlockTitle);
  return [
    { title: `Expand ${title}`, detail: 'Add linked detail to this research block' },
    { title: `What evidence supports ${title}?`, detail: 'Trace and challenge its citations' },
    { title: `Draw the next step from ${title}`, detail: 'Extend this part of the map' },
  ];
}

function visibleBlockSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  if ((view.answerFocus?.visibleBlockTitles?.length ?? 0) <= 1) return null;
  return [
    { title: 'How do these visible blocks connect?', detail: 'Explain the structure in view' },
    { title: 'What is missing between these blocks?', detail: 'Extend the visible part of the map' },
    { title: 'Which block needs more evidence?', detail: 'Check the citations' },
  ];
}

function focusedSourceSuggestions({ view, canvas, answerCanvas }: SuggestionContext): ChatSuggestion[] | null {
  const id = view.answerFocus?.focusedSourceId;
  if (!id) return null;
  const source = answerCanvas?.sources.find(item => item.blockId === id);
  const title = source?.title ?? canvas?.blocks.find(block => block.id === id)?.title ?? 'this source';
  const name = shortSuggestionTitle(title);
  return [
    { title: `What does ${name} actually support?`, detail: 'Inspect the selected evidence' },
    { title: `What challenges ${name}?`, detail: 'Find counterevidence' },
    { title: `What is missing from ${name}?`, detail: 'Find gaps in this source' },
  ];
}

function focusedQuestionSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  if (!view.answerFocus?.focusedQuestion) return null;
  return [
    { title: `What supports “${shortSuggestionTitle(view.answerFocus.focusedQuestion)}”?`, detail: 'Trace this answer to sources' },
    { title: 'Which part of this answer is uncertain?', detail: 'Check the evidence' },
    { title: 'How does this answer change the plan?', detail: 'Connect it to next actions' },
  ];
}

function visibleQuestionSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  if ((view.answerFocus?.visibleQuestions.length ?? 0) <= 1) return null;
  return [
    { title: 'How do these answers connect?', detail: 'Synthesize the visible answers' },
    { title: 'Do these answers conflict?', detail: 'Check the evidence across turns' },
    { title: 'What is the next useful question?', detail: 'Expand the conversation map' },
  ];
}

function answerSourceSuggestions({ answerCanvas }: SuggestionContext): ChatSuggestion[] | null {
  if (!answerCanvas?.sources.length) return null;
  return [
    { title: 'Which sources disagree?', detail: 'Check the evidence from this answer' },
    { title: 'What is still unknown?', detail: 'Find gaps in the selected sources' },
    { title: 'What should we do next?', detail: 'Turn these findings into a plan' },
  ];
}
