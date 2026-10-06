import { ChevronDown } from 'lucide-react';
import { Conversation, ConversationContent, ConversationScrollButton } from './components/ai-elements/conversation';
import { SavedInvestigations } from './SavedInvestigations';
import { ChatComposer, TurnMessage } from './chat-messages';
import type { ChatModel } from './chat-model';
import { useEscapeLayer } from './escape-layers';

export function AIElementsChatView(chat: ChatModel) {
  return <div className="ai-chat">
    <ChatSetup chat={chat} /><ChatSavedContext chat={chat} />
    <Conversation className="ai-chat__conversation">
      <ConversationContent className="ai-chat__messages"><ChatWelcome chat={chat} /><ChatTurns chat={chat} /><ChatError chat={chat} /></ConversationContent>
      <ConversationScrollButton className="ai-chat__scroll-latest" aria-label="Scroll to latest message" />
    </Conversation>
    <ChatSuggestions chat={chat} /><ChatScope chat={chat} />
    <ChatComposer canvasId={chat.canvasId} hasApiKey={chat.hasApiKey} model={chat.model} input={chat.input} status={chat.status} onInput={chat.setInput} onSubmit={chat.submit}
      onStop={() => chat.activeRef.current?.abort()} placeholder={chat.viewContext.editorDraft || chat.viewContext.editingBlockId ? 'Ask Symbi to review or edit this document…' : undefined} />
  </div>;
}
function ChatSetup({ chat }: { chat: ChatModel }) {
  return !chat.hasApiKey && <div className="ai-chat__setup"><span>Connect a chat model in Settings to talk with this canvas.</span><button type="button" onClick={chat.onOpenSettings}>Open Settings</button></div>;
}
function ChatSavedContext({ chat }: { chat: ChatModel }) {
  return <>
    {chat.canvas?.workspaceId && <SavedInvestigations workspaceId={chat.canvas.workspaceId} canvasId={chat.canvasId}
      messages={chat.turns.filter(turn => turn.content.trim()).map(({ role, content }) => ({ role, content }))}
      sourceRefs={chat.investigationSources} proposalRefs={chat.investigationProposals}
      researchSnapshot={chat.researchEdits && chat.researchLayout ? { turns: chat.answerTurns, edits: chat.researchEdits, layout: chat.researchLayout } : undefined}
      openRequest={chat.investigationOpenRequest} onOpen={chat.openInvestigation}
      onSaved={record => chat.onActiveInvestigationChange?.({ id: record.id, canvasId: record.canvasId ?? chat.canvasId })}
      onClearSelection={() => chat.onActiveInvestigationChange?.(undefined)}
      onOpenSource={chat.openInvestigationSource} onOpenProposal={chat.openInvestigationProposal} onRecheck={chat.recheckInvestigation} />}
    <PreviousConversation chat={chat} />
    {chat.savedSourceOpened && <div className="ai-chat__saved-return" role="status">Opened a saved source.
      <button type="button" onClick={() => { chat.onReturnNavigation(); chat.setSavedSourceOpened(false); }}>Go back</button></div>}
  </>;
}
function PreviousConversation({ chat }: { chat: ChatModel }) {
  if (!chat.previousConversation) return null;
  return <div className="ai-chat__saved-return" role="status">Opened a saved investigation.
    <button type="button" onClick={() => {
      chat.cancelConversation(); chat.commit(chat.previousConversation!); chat.onRestoreResearch?.(chat.previousResearch);
      chat.onActiveInvestigationChange?.(undefined); chat.setPreviousConversation(null); chat.setPreviousResearch(undefined);
    }}>Restore previous conversation and canvas</button>
    <button type="button" onClick={() => { chat.setPreviousConversation(null); chat.setPreviousResearch(undefined); }}>Dismiss</button></div>;
}
function ChatWelcome({ chat }: { chat: ChatModel }) {
  if (chat.turns.length) return null;
  return <div className="ai-chat__welcome"><h2>Hi, I’m Symbi.</h2>
    <p>{chat.canvasId ? 'Ask me to find sources, connect ideas, or build a map of what matters. I’ll show you where the answer came from.' : 'Open a canvas and ask me to find sources, connect ideas, or build a map of what matters.'}</p></div>;
}
function ChatTurns({ chat }: { chat: ChatModel }) {
  return chat.turns.map((turn, index) => <TurnMessage key={turn.id} turn={turn} status={chat.status} latestId={chat.latestId} avatarState={chat.avatarState}
    undoingBlockId={chat.undoingBlockId} onReturnNavigation={chat.onReturnNavigation} onUndoCreated={(id, block) => void chat.undoCreated(id, block)} onUndoEdited={(id, edit) => void chat.undoEdited(id, edit)}
    onSelectProposal={chat.selectProposal} onApplyProposal={id => void chat.applyProposal(id)} onUndoProposal={id => void chat.undoProposal(id)}
    question={turn.role === 'assistant' ? chat.turns.slice(0, index).reverse().find(item => item.role === 'user')?.content : undefined} onShowBlock={chat.onShowBlock}
    onOpenAnswerCanvas={chat.onOpenAnswerCanvas} onChooseSurface={chat.submit} />);
}
function ChatError({ chat }: { chat: ChatModel }) {
  if (!chat.error) return null;
  return <div className="ai-chat__error" role="alert">
    <div className="ai-chat__error-text"><strong>Symbi couldn’t finish this answer.</strong><span>{chat.error}</span><ConnectionNotice chat={chat} /></div>
    {chat.hasApiKey && <button type="button" className="primary-button" onClick={chat.retry}>{chat.connection === 'restored' ? 'Retry answer' : 'Retry'}</button>}</div>;
}
function ConnectionNotice({ chat }: { chat: ChatModel }) {
  return chat.connection !== 'online' && <small>{chat.connection === 'restored' ? 'Connection restored. Your question is ready to retry.' : 'Checking the connection. Your question is still here.'}</small>;
}
function ChatSuggestions({ chat }: { chat: ChatModel }) {
  if (chat.turns.length === 0) return <div className="ai-chat__starters" role="group" aria-label="Suggested questions">{chat.suggestions.slice(0, 3).map(item =>
    <button key={item.title} type="button" className="ai-chat__starter" onClick={() => chat.submit(item.title)}><strong>{item.title}</strong><span>{item.detail}</span></button>)}</div>;
  return chat.status === 'ready' && <div className="ai-chat__followups" role="group" aria-label="Suggested follow-up questions">{chat.suggestions.slice(0, 2).map(item =>
    <button key={item.title} type="button" onClick={() => chat.submit(item.title)}>{item.title}</button>)}</div>;
}
function ChatScope({ chat }: { chat: ChatModel }) {
  useEscapeLayer(chat.scopeOpen, () => chat.setScopeOpen(false));
  return <div className="ai-chat__context">
    <button type="button" aria-label="Choose assistant context" aria-expanded={chat.scopeOpen} onClick={() => chat.setScopeOpen(open => !open)}>
      <span aria-live="polite">Using: <strong key={chat.activeScope.detail} className="ai-chat__context-value">{chat.activeScope.detail}</strong></span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {chat.scopeOpen && <div className="ai-chat__context-options" role="group" aria-label="Assistant context options">
      {chat.scopes.map(option => <button key={option.id} type="button" aria-pressed={chat.activeScope.id === option.id}
        onClick={() => { chat.setScope(option.id); chat.setScopeOpen(false); }}><strong>{option.label}</strong><span>{option.detail}</span></button>)}
    </div>}
  </div>;
}
