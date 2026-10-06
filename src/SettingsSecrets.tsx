import { useState } from 'react';
import { Trash2 } from 'lucide-react';

export function SecretsEditor({ names, pending, onPending }: { names: string[]; pending: Record<string, string | null>; onPending: (next: Record<string, string | null>) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valid = /^[A-Z][A-Z0-9_]{0,63}$/.test(name);
  const listed = [...new Set([...names, ...Object.keys(pending).filter(key => pending[key] !== null)])].sort();
  return <div className="secrets-editor">
    {listed.length === 0 && <p className="settings-empty">No secrets saved yet.</p>}
    {listed.map(secret => <div className="secrets-editor__row" key={secret}>
      <code>{secret}</code>
      <span>{pending[secret] === null ? 'Will be removed' : pending[secret] !== undefined ? 'Will be saved' : 'Saved'}</span>
      {pending[secret] === null
        ? <button type="button" className="secondary-button" onClick={() => { const next = { ...pending }; delete next[secret]; onPending(next); }}>Undo</button>
        : <button type="button" className="icon-button" aria-label={`Remove secret ${secret}`} onClick={() => {
          const next = { ...pending };
          if (names.includes(secret)) next[secret] = null; else delete next[secret];
          onPending(next);
        }}><Trash2 size={14}/></button>}
    </div>)}
    <div className="secrets-editor__new">
      <input aria-label="Secret name" value={name} onChange={event => setName(event.target.value.toUpperCase())} placeholder="GITHUB_TOKEN"/>
      <input aria-label="Secret value" type="password" autoComplete="new-password" value={value} onChange={event => setValue(event.target.value)} placeholder="Value"/>
      <button type="button" className="secondary-button" disabled={!valid || !value} onClick={() => { onPending({ ...pending, [name]: value }); setName(''); setValue(''); }}>Add secret</button>
    </div>
    <small>Use capital letters, digits, and underscores. Values never come back to the browser; reference them as <code>{'${secret:NAME}'}</code> in MCP headers.</small>
  </div>;
}
