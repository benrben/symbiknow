import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    setError('');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopied(true); window.setTimeout(() => setCopied(false), 1400);
    } catch { setCopied(false); setError('Could not copy. Select and copy the text manually.'); }
  }
  return <><button type="button" className="settings-copy" onClick={() => { void copy(); }}>
    {copied ? <Check size={12} aria-hidden="true"/> : <Copy size={12} aria-hidden="true"/>}{copied ? 'Copied' : label}
  </button>{error && <span role="alert">{error}</span>}</>;
}

export function Snippet({ title, note, code }: { title: string; note?: ReactNode; code: string }) {
  return <div className="connection-card">
    <div className="connection-card__top"><strong>{title}</strong><CopyButton text={code}/></div>
    {note && <p>{note}</p>}
    <pre className="connection-snippet">{code}</pre>
  </div>;
}

