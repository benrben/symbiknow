import type { SavedInvestigationsProps } from './saved-investigation-types';

function invalidMessage(message: SavedInvestigationsProps['messages'][number]) {
  return !message.content.trim() || message.content.length > 20_000;
}
function exceedsCount(props: SavedInvestigationsProps) {
  return props.messages.length > 100 || props.sourceRefs.length > 100 || props.proposalRefs.length > 100;
}
export function saveLimitError(props: SavedInvestigationsProps): string {
  if (exceedsCount(props) || props.messages.some(invalidMessage)) {
    return 'This investigation exceeds the save limit: up to 100 messages and references, with each message under 20,000 characters.';
  }
  if (props.researchSnapshot && new TextEncoder().encode(JSON.stringify(props.researchSnapshot)).length > 1_000_000) {
    return 'The research canvas exceeds the 1 MB investigation limit. Save a smaller research session or export the canvas first.';
  }
  return '';
}
export function investigationData(props: SavedInvestigationsProps, title: string, visibility: 'private' | 'shared') {
  const { canvasId, messages, sourceRefs, proposalRefs, researchSnapshot } = props;
  return {
    canvasId, title: title.trim(), visibility, question: messages.find(message => message.role === 'user')?.content.slice(0, 2_000),
    messages, sourceRefs, proposalRefs, ...(researchSnapshot ? { researchSnapshot } : {})
  };
}
