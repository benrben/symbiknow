import { groupPath, normalizedGroup } from '../shared/groups';
import { firstSuggestions } from './chat-suggestion-rules';
import { shortSuggestionTitle, suggestionGroupTitle } from './chat-suggestion-titles';
import type { ChatSuggestion, SuggestionContext } from './chat-suggestion-types';

export function contextSuggestions(context: SuggestionContext): ChatSuggestion[] | null {
  return firstSuggestions(context, [searchSuggestions, activeGroupSuggestions, visibleGroupSuggestions, conversationSuggestions]);
}

function searchSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  const query = view.searchQuery?.trim();
  if (!query) return null;
  return [
    { title: `Which sources best answer “${shortSuggestionTitle(query)}”?`, detail: 'Compare the search results' },
    { title: 'What did this search miss?', detail: 'Look across the workspace' },
    { title: 'Summarize the strongest evidence', detail: 'Open a temporary answer canvas' },
  ];
}

function activeGroupSuggestions({ view, canvas }: SuggestionContext): ChatSuggestion[] | null {
  if (!view.activeGroup) return null;
  const group = view.activeGroup;
  const count = canvas?.blocks.filter(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped').includes(group)).length ?? 0;
  const name = suggestionGroupTitle(group);
  return [
    { title: `What matters most in ${name}?`, detail: `${count} document${count === 1 ? '' : 's'} in this group` },
    { title: `Which sources in ${name} disagree?`, detail: 'Compare this part of the canvas' },
    { title: `What is missing from ${name}?`, detail: 'Find gaps and next steps' },
  ];
}

function visibleGroupSuggestions({ view }: SuggestionContext): ChatSuggestion[] | null {
  if (!view.visibleGroups?.length || view.viewMode === 'documents') return null;
  const names = view.visibleGroups.slice(0, 2).map(suggestionGroupTitle).join(' and ');
  return [
    { title: `How do ${names} connect?`, detail: `${view.visibleGroups.length} visible group${view.visibleGroups.length === 1 ? '' : 's'}` },
    { title: 'Which visible group needs attention?', detail: 'Compare the groups in view' },
    { title: 'What is missing between these groups?', detail: 'Find cross-group gaps' },
  ];
}

function conversationSuggestions({ answerCanvas }: SuggestionContext): ChatSuggestion[] | null {
  if (!answerCanvas?.sources.length) return null;
  return [
    { title: 'Which sources disagree?', detail: 'Compare evidence from our conversation' },
    { title: 'What is still unknown?', detail: 'Find gaps in our conversation' },
    { title: 'What should we do next?', detail: 'Turn the answers into a plan' },
  ];
}

export function fallbackSuggestions({ canvas }: SuggestionContext): ChatSuggestion[] {
  if (!canvas?.blocks.length) return [
    { title: 'Help me plan this canvas', detail: 'Start with goals and sources' },
    { title: 'What should I add first?', detail: 'Get a practical starting point' },
  ];
  return [
    { title: `What matters most in ${shortSuggestionTitle(canvas.name)}?`, detail: 'See the most useful documents' },
    { title: 'Which documents disagree?', detail: 'Find conflicting claims' },
    { title: 'What is missing or outdated?', detail: 'Spot gaps in this canvas' },
    { title: 'What should the team do next?', detail: 'Use the available documents' },
  ];
}
