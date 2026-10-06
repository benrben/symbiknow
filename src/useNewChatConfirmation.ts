import { useEffect, useRef, useState } from 'react';
import type { AppModel } from './app-model';
import { errorText } from './app-state-helpers';

type NewChatModel = Pick<AppModel, 'chatHasHistory' | 'answerTurns' | 'newChat' | 'saveResearchCanvas' | 'researchLayout'>;

export function useNewChatConfirmation(model: NewChatModel) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => { generation.current++; }, []);

  function close() {
    generation.current++;
    setOpen(false);
    setSaving(false);
  }

  function start() {
    if (!model.chatHasHistory && !model.answerTurns.length) { model.newChat(); return; }
    generation.current++;
    setError('');
    setSaving(false);
    setOpen(true);
  }

  function discard() { model.newChat(); close(); }

  function finish(version: number) {
    if (generation.current === version) setSaving(false);
    if (pending.current === version) pending.current = undefined;
  }

  async function save() {
    const version = generation.current;
    if (pending.current === version) return;
    pending.current = version;
    setSaving(true);
    setError('');
    try {
      await model.saveResearchCanvas(model.researchLayout);
      // Closing the confirmation leaves its authorized save intact, while a
      // later conversation or confirmation owns the current UI.
      if (generation.current === version) discard();
    } catch (failure) {
      if (generation.current === version) setError(errorText(failure));
    } finally {
      finish(version);
    }
  }

  return { open, saving, error, close, start, discard, save };
}
