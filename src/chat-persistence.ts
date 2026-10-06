import { useEffect } from 'react';
import { chatHistoryKey } from './chat-history';
import type { AIElementsChatProps } from './chat-types';
import { type SymbiState } from './SymbiAvatar';

import type { ChatState } from './chat-state';
export function useChatPersistence(props: AIElementsChatProps, state: ChatState, avatarState: SymbiState) {
  const { focusRequest, onAvatarStateChange, onHistoryChange } = props;
  const { input, turns, error, setScope, setConnection, turnsRef, activeRef, finishTimer } = state;
  useEffect(() => { onAvatarStateChange?.(avatarState); }, [avatarState, onAvatarStateChange]);
  useEffect(() => { onHistoryChange?.(turns.length > 0); }, [turns.length, onHistoryChange]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(chatHistoryKey, JSON.stringify(turns.slice(-60))); }
      catch { console.warn('Chat history cannot be saved; the current conversation remains available in memory.'); }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [turns]);
  useEffect(() => {
    const flush = () => {
      try { window.localStorage.setItem(chatHistoryKey, JSON.stringify(turnsRef.current.slice(-60))); }
      catch { console.warn('Chat history could not be saved before leaving the page.'); }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => {
    if (!focusRequest) return;
    setScope('view');
    document.querySelector<HTMLTextAreaElement>('.chat-panel textarea[aria-label="Message Symbi"]')?.focus();
  }, [focusRequest]);
  useEffect(() => () => {
    activeRef.current?.abort();
    activeRef.current = null;
    if (finishTimer.current) clearTimeout(finishTimer.current);
  }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem('symbiknow:chat-draft', input); }
    catch { console.warn('The chat draft cannot be saved; it remains available until this page closes.'); }
  }, [input]);
  useEffect(() => {
    if (!error.includes('server is unavailable')) { setConnection('online'); return; }
    setConnection('checking');
    let active = true;
    let checking = false;
    const probe = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/workspaces', { cache: 'no-store' });
        if (active && response.ok) { setConnection('restored'); window.clearInterval(timer); }
      } catch { console.warn('Canvas reconnect check failed; the visible error remains and the check will retry.'); }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => { if (active) void probe(); }, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [error]);
}
