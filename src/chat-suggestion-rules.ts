import type { ChatSuggestion, SuggestionContext, SuggestionRule } from './chat-suggestion-types';

export function firstSuggestions(context: SuggestionContext, rules: SuggestionRule[]): ChatSuggestion[] | null {
  for (const rule of rules) {
    const suggestions = rule(context);
    if (suggestions) return suggestions;
  }
  return null;
}
