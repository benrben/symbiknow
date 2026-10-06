import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { TurnMessageProps } from './chat-message-types';

export function AnswerActions({ turn, answering }: Pick<TurnMessageProps, 'turn'> & { answering: boolean }) {
  if (!turn.content || answering || turn.answerCanvas || turn.researchPatch) return null;
  return <div className="ai-chat__actions"><CopyButton text={turn.content} /></div>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { setCopied(false); setError('Could not copy answer. Select the answer text and copy it.'); }
  }
  return <><button type="button" className="ai-chat__action" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy answer'} title="Copy answer">
    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
  </button>{error && <span role="alert">{error}</span>}</>;
}

