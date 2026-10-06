import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useAppModel } from './app-model';
import { AssistantPanel } from './AppAssistantPanel';
import { AppOverlays } from './AppOverlays';
import { BrandMark, ThemeToggle } from './AppIcon';
import { MainColumn, Sidebar } from './AppWorkspaceView';
import { locationFor, urlParam } from './app-model-helpers';
import { applyTheme, preferredTheme, type Theme } from './theme';

export type { AppModel } from './app-model';

function LoginScreen({ onSignIn, theme, onToggleTheme }: { onSignIn: (token: string) => Promise<string>; theme: Theme; onToggleTheme: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="login-screen"><form className="login-card" onSubmit={async event => {
    event.preventDefault();
    setBusy(true);
    setError(await onSignIn(token));
    setBusy(false);
  }}>
    <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
    <BrandMark/>
    <h1>Sign in to SymbiKnow</h1>
    <p>This workspace is protected. Enter the access token your admin set as <code>SYMBIKNOW_ACCESS_TOKEN</code>.</p>
    <label>Access token<input type="password" autoFocus autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)}/></label>
    {error && <p className="login-card__error" role="alert">{error}</p>}
    <button className="primary-button" disabled={busy || !token}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></div>;
}

export function App() {
  const model = useAppModel();
  const [page, setPage] = useState<'canvas' | 'tasks'>(() => urlParam('view') === 'tasks' ? 'tasks' : 'canvas');
  const previousCanvasId = useRef(model.canvasId);
  useEffect(() => {
    if (previousCanvasId.current !== model.canvasId) setPage(urlParam('view') === 'tasks' ? 'tasks' : 'canvas');
    previousCanvasId.current = model.canvasId;
  }, [model.canvasId]);
  useEffect(() => {
    const restorePage = () => setPage(urlParam('view') === 'tasks' ? 'tasks' : 'canvas');
    window.addEventListener('popstate', restorePage);
    return () => window.removeEventListener('popstate', restorePage);
  }, []);
  const openTasks = () => {
    if (urlParam('view') !== 'tasks') window.history.pushState({ tasksView: true }, '', locationFor(model.canvasId, '', 'tasks'));
    setPage('tasks');
  };
  const openCanvas = () => {
    if (urlParam('view') === 'tasks') window.history.pushState({ canvasView: true }, '', locationFor(model.canvasId));
    setPage('canvas');
  };
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark');
  if (model.authRequired) return <LoginScreen onSignIn={model.signIn} theme={theme} onToggleTheme={toggleTheme}/>;
  return <div className={appShellClass(model)}
    style={{ '--document-chat-width': `${model.documentAssistantWidth}px` } as CSSProperties}>
    <Sidebar model={model} page={page} onOpenTasks={openTasks} onOpenCanvas={openCanvas}/>
    <MainColumn model={model} theme={theme} onToggleTheme={toggleTheme} page={page} onOpenCanvas={openCanvas}/>
    <AssistantPanel model={model}/>
    <AppOverlays model={model}/>

  </div>;
}

function appShellClass(model: ReturnType<typeof useAppModel>) {
  const documentFocused = focusedDocument(model);
  return ['app-shell', model.answerCanvasOpen ? 'is-researching' : '',
    documentFocused ? 'is-document-focused' : '', documentFocused && model.showChat ? 'has-document-chat' : ''].filter(Boolean).join(' ');
}

function focusedDocument(model: ReturnType<typeof useAppModel>) {
  return model.dialog === 'block' || (!model.dialog && Boolean(model.readerId));
}
