import { useRef } from 'react';
import { useModalFocus } from './useModalFocus';

type ConfirmationProps = {
  canSave: boolean; open: boolean; saving: boolean; error: string;
  onClose: () => void; onDiscard: () => void; onSave: () => Promise<void>;
};

export function NewChatConfirmation(props: ConfirmationProps) {
  return props.open ? <ConfirmationDialog {...props} /> : null;
}

function ConfirmationDialog({ canSave, saving, error, onClose, onDiscard, onSave }: ConfirmationProps) {
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog, onClose, false);
  return <div className="ai-chat__new-session-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="ai-chat__new-session" role="alertdialog" aria-modal="true" aria-label="Start a new chat">
      <h2>Start a new chat?</h2><p>This clears the conversation, temporary research canvas, and proposal or Undo controls in this chat. Saved documents stay in place.</p>
      {error && <p role="alert">{error}</p>}
      <div className="ai-chat__new-session-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Keep working</button>
        {canSave && <button type="button" className="secondary-button" disabled={saving} onClick={() => void onSave()}>{saving ? 'Saving…' : 'Save research and start'}</button>}
        <button type="button" className="danger-button" disabled={saving} onClick={onDiscard}>Discard and start</button>
      </div>
    </section>
  </div>;
}
