import type { AppModel } from './app-model';
import { Icon, ThemeToggle } from './AppIcon';
import type { Theme } from './theme';

export function WorkspaceToolbar({ model, theme, onToggleTheme }: { model: AppModel; theme: Theme; onToggleTheme: () => void }) {
  const {
    canvasId, setSearchOpen, setBrowseGroupsOpen, uploadRef, uploadFiles,
    openNewBlock, showChat, setShowChat,
  } = model;
  return <header className="topbar">
    <WorkspaceBreadcrumb model={model}/>
    <div className="top-actions">
      <button className="toolbar-button search-trigger" aria-label="Search documents" title="Search documents" onClick={() => {
        if (model.answerCanvasOpen) model.requestResearchAction('search');
        else setSearchOpen(true);
      }}><Icon name="search" size={17}/><span className="toolbar-label">Search documents</span><kbd>⌘ K</kbd></button>
      <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
      <button className="toolbar-button upload-trigger" aria-label="Upload files" title="Upload files" onClick={() => uploadRef.current?.click()} disabled={!canvasId}><Icon name="upload" size={17}/><span className="toolbar-label">Upload files</span></button>
      <input ref={uploadRef} type="file" accept=".md,.mdx,.html,text/markdown,text/html" multiple hidden onChange={event => {
        if (model.answerCanvasOpen) model.requestResearchAction('upload', Array.from(event.target.files ?? []));
        else void uploadFiles(event.target.files);
        event.target.value = '';
      }}/>
      <button className="primary-button" aria-label="Create note" title="Create note" onClick={() => model.answerCanvasOpen ? model.requestResearchAction('add') : openNewBlock()} disabled={!canvasId}><Icon name="plus" size={17}/><span className="toolbar-label">Create note</span></button>
      <button className="toolbar-button" aria-label="Browse groups" title="Browse groups" onClick={() => {
        if (model.answerCanvasOpen) model.requestResearchAction('groups');
        else { setSearchOpen(false); setBrowseGroupsOpen(true); }
      }} disabled={!canvasId}><Icon name="layers" size={17}/><span className="toolbar-label">Browse groups</span></button>
      <button className={'chat-toggle ' + (showChat ? 'selected' : '')} aria-label="Toggle Symbi" title="Toggle Symbi" onClick={() => setShowChat(value => !value)}><Icon name="spark" size={18}/></button>
    </div>
  </header>;
}

function WorkspaceBreadcrumb({ model }: { model: AppModel }) {
  const { workspaces, canvas, canvasId } = model;
  const activeWorkspace = workspaces.find(workspace => workspace.id === canvas?.workspaceId || workspace.canvases.some(item => item.id === canvasId));
  return <div className="breadcrumb"><span>{activeWorkspace?.name || 'Workspace'}</span><Icon name="chevron" size={14}/><strong>{model.answerCanvasOpen ? 'Research canvas' : canvas?.name || 'Canvas'}</strong></div>;
}
