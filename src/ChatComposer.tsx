import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from './components/ai-elements/prompt-input';
import type { AIElementsChatProps, ChatStatus } from './chat-types';

type ChatComposerProps = Pick<AIElementsChatProps, 'canvasId' | 'hasApiKey' | 'model'> & {
  input: string;
  status: ChatStatus;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  onStop: () => void;
  placeholder?: string;
};

export function ChatComposer({ canvasId, hasApiKey, model, input, status, onInput, onSubmit, onStop, placeholder }: ChatComposerProps) {
  return <div className="ai-chat__composer">
    <PromptInput onSubmit={({ text }) => onSubmit(text)}>
      <PromptInputBody><PromptInputTextarea aria-label="Message Symbi" value={input} onChange={event => onInput(event.currentTarget.value)} placeholder={placeholder ?? (canvasId ? 'Ask Symbi about this canvas…' : 'Open a canvas to start chatting…')} /></PromptInputBody>
      <PromptInputFooter><span>{hasApiKey ? model : 'Set up chat in Settings'}</span><PromptInputSubmit status={status} onStop={onStop} disabled={!input.trim() && status === 'ready'} /></PromptInputFooter>
    </PromptInput>
  </div>;
}

