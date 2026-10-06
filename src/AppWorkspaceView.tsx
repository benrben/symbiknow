import { memo } from 'react';
import { AnswerCanvas } from './AnswerCanvas';
import type { AppModel } from './app-model';
import { dialogShowsError } from './app-dialog-errors';
import { BrandMark, Icon } from './AppIcon';
import { BrowseGroups } from './BrowseGroups';
import { Canvas } from './Canvas';
import { CanvasSearch } from './CanvasSearch';
import { type Theme } from './theme';
import { WorkspaceToolbar } from './AppWorkspaceToolbar';
import { useWorkspaceCanvasEvents } from './useWorkspaceCanvasEvents';

const MemoCanvas = memo(Canvas);

export function Sidebar({ model }: { model: AppModel }) {
  const { workspaces, canvasId, selectCanvas, requestDeleteCanvas, requestDeleteWorkspace, setDialog, openNamedDialog } = model;
  return <aside className="sidebar">
    <div className="brand"><BrandMark/><div><strong>symbiknow</strong><span>People + AI · infinite canvas</span></div></div>
    <div className="sidebar-section-label">WORKSPACES <button className="icon-button subtle" title="New workspace" aria-label="New workspace" onClick={() => openNamedDialog('workspace')}><Icon name="plus" size={16}/></button></div>
    <div className="workspace-list">{workspaces.map(workspace => <div key={workspace.id} className="workspace-group"><div className="workspace-title"><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span className="workspace-name">{workspace.name}</span><button type="button" className="workspace-delete" title={`Delete workspace: ${workspace.name}`} aria-label={`Delete workspace: ${workspace.name}`} onClick={() => requestDeleteWorkspace(workspace)}><Icon name="trash" size={15}/></button></div><div className="canvas-links">{workspace.canvases.map(item => <div className={'canvas-link-row ' + (canvasId === item.id ? 'active' : '')} key={item.id}><button className="canvas-link" title={`Open canvas: ${item.name}`} aria-label={`Open canvas: ${item.name}`} onClick={() => selectCanvas(item.id)}><Icon name="grid" size={15}/><span>{item.name}</span></button><button className="canvas-link-delete" title={`Delete canvas: ${item.name}`} aria-label={`Delete canvas: ${item.name}`} onClick={() => requestDeleteCanvas(item.id, item.name, workspace.id)}><Icon name="trash" size={15}/></button></div>)}</div></div>)}</div>
    <button className="sidebar-new" title="New canvas" aria-label="New canvas" onClick={() => openNamedDialog('canvas')}><Icon name="plus" size={16}/> New canvas</button>
    <div className="sidebar-spacer"/>
    <div className="sidebar-bottom"><button title="Settings" aria-label="Settings" onClick={() => setDialog('settings')}><Icon name="settings" size={17}/><span>Settings</span></button><div className="sidebar-status" title={window.location.host}><span className="status-dot"/>{/^(localhost|127\.0\.0\.1)(:|$)/.test(window.location.host) ? 'Local workspace' : window.location.host}</div></div>
  </aside>;
}

export function MainColumn({ model, theme, onToggleTheme }: { model: AppModel; theme: Theme; onToggleTheme: () => void }) {
  return <div className="main-column">
    <WorkspaceToolbar model={model} theme={theme} onToggleTheme={onToggleTheme}/>
    <GlobalErrorBanner model={model}/>
    <CanvasArea model={model} theme={theme}/>
  </div>;
}

function GlobalErrorBanner({ model }: { model: AppModel }) {
  if (!model.error || dialogShowsError(model.dialog)) return null;
  return <div className="global-error" role="alert"><span>{model.error}</span>
    {model.error.includes('server is unavailable') && <button type="button" onClick={model.retryConnection}>Reconnect</button>}
    <button aria-label="Dismiss error" onClick={() => model.setError('')}><Icon name="close" size={15}/></button></div>;
}

function CanvasArea({ model, theme }: { model: AppModel; theme: Theme }) {
  const events = useWorkspaceCanvasEvents(model);
  const { canvas } = model;
  if (!canvas) return <EmptyCanvas model={model}/>;
  return <main className={canvasMainClass(model)}>
    <CanvasLabel name={canvas.name}/>
    <CanvasSurface model={model} canvas={canvas} theme={theme} events={events}/>

    <CanvasSearchPanel model={model} canvasId={canvas.id}/>
    <CanvasGroupPanels model={model} canvas={canvas}/>
    <FirstBlockPrompt model={model} canvas={canvas}/>
    <ResearchCanvas model={model} theme={theme}/>
  </main>;
}

function canvasMainClass(model: AppModel) {
  const grouping = model.browseGroupsOpen;
  return `canvas-main${model.searchOpen ? ' is-searching' : ''}${grouping ? ' is-grouping' : ''}`;
}

function CanvasLabel({ name }: { name: string }) {
  return <div className="canvas-label"><span className="eyebrow">PEOPLE + AI · INFINITE CANVAS</span><h1>{name}</h1><p>An infinite canvas where people and AI organize ideas and build knowledge together.</p></div>;
}

function CanvasSurface({ model, canvas, theme, events }: {
  model: AppModel; canvas: NonNullable<AppModel['canvas']>; theme: Theme; events: ReturnType<typeof useWorkspaceCanvasEvents>;
}) {
  const {
    selectBlock, readBlock, openCrossLink, historyBlock, selectionChanged,
    summarizeSelection, viewportChanged, searchMatchIds,
  } = events;
  return <MemoCanvas canvas={canvas} theme={theme} crossLinkLabels={model.crossLinkLabels} onUpdateBlock={model.updateBlock} onDeleteBlock={model.deleteCanvasBlock} onSelectBlock={selectBlock} onReadBlock={readBlock} onOpenCrossLink={openCrossLink} onHistoryBlock={historyBlock} onMoveBlocks={model.moveBlocks}
      focusRequest={canvasBoundRequest(model.focusRequest, canvas.id)}
      groupFocusRequest={canvasBoundRequest(model.groupFocusRequest, canvas.id)}
      searchQuery={model.searchOpen ? model.searchQuery : ''} searchMatchIds={searchMatchIds} activeSearchId={model.activeSearchId}
      viewportRequest={model.viewportRequest}
      onViewportChange={viewportChanged} onSelectionChange={selectionChanged} onSummarizeSelection={summarizeSelection}/>;
}

function canvasBoundRequest<T extends { canvasId: string }>(request: T | null, canvasId: string) {
  if (!request) return undefined;
  return request.canvasId === canvasId ? request : undefined;
}

function CanvasSearchPanel({ model, canvasId }: { model: AppModel; canvasId: string }) {
  if (!model.searchOpen) return null;
  return <CanvasSearch query={model.searchQuery} hits={model.searchHits} loading={model.searching || model.searchResultQuery !== model.searchQuery.trim()} error={model.searchError} onRetry={model.retrySearch} currentCanvasId={canvasId} currentContentHashes={model.searchCurrentContentHashes}
      onQuery={model.setSearchQuery} onClose={() => model.setSearchOpen(false)} onReveal={hit => void model.revealSearchHit(hit)} onEdit={hit => void model.selectSearchHit(hit)} onOpenEvidence={model.openSearchEvidence}/>;
}

function CanvasGroupPanels({ model, canvas }: { model: AppModel; canvas: NonNullable<AppModel['canvas']> }) {
  return <>
    {model.browseGroupsOpen && <BrowseGroups canvas={canvas} onOpenBlock={blockId => { model.setBrowseGroupsOpen(false); model.openReader(blockId); }}
      onClose={() => model.setBrowseGroupsOpen(false)}/>}
  </>;
}

function FirstBlockPrompt({ model, canvas }: { model: AppModel; canvas: NonNullable<AppModel['canvas']> }) {
  if (canvas.blocks.length > 0) return null;
  return <div className="canvas-empty-prompt">
      <BrandMark/>
      <span className="eyebrow">START HERE</span>
      <h2>Make knowledge together.</h2>
      <p>Add a source or an idea. Your team and its AI agents can connect, organize, and build on it across this infinite canvas.</p>
      <div className="canvas-empty-prompt__actions">
        <button className="primary-button" onClick={() => model.openNewBlock()}><Icon name="plus" size={17}/> Create note</button>
        <button className="secondary-button" onClick={() => model.uploadRef.current?.click()}><Icon name="upload" size={17}/> Upload files</button>
      </div>
    </div>;
}

function ResearchCanvas({ model, theme }: { model: AppModel; theme: Theme }) {
  if (!model.answerCanvasOpen || model.answerTurns.length === 0) return null;
  return <AnswerCanvas turns={model.answerTurns} layout={model.researchLayout} theme={theme}
      edits={model.researchState.edits} canUndo={model.researchState.history.length > 0} historyCount={model.researchState.history.length}
      actionRequest={model.researchActionRequest}
      hasSavedCopy={model.researchSaveCount > 0}
      onEditsChange={model.changeResearchEdits} onUndo={model.undoResearchEdit}
      onLayoutChange={model.setResearchLayout} onSave={model.saveResearchCanvas}
      onOpenSavedCanvas={(id, name) => model.navigateTo({ canvasId: id, canvasName: name })}
      onClose={() => model.setAnswerCanvasOpen(false)} onRecheck={model.recheckAnswer}
      onAskSelection={model.summarizeResearchSelection}
      onViewFocusChange={focus => model.setAnswerCanvasViewFocus(current => JSON.stringify(current) === JSON.stringify(focus) ? current : focus)}
      onOpenSource={model.openResearchSource}/>;
}

function EmptyCanvas({ model }: { model: AppModel }) {
  return <main className="canvas-main"><div className="empty-state">
    <div className="empty-icon"><Icon name="grid" size={30}/></div>
    <h2>{emptyCanvasTitle(model)}</h2>
    <p>{emptyCanvasDescription(model)}</p>
    <EmptyCanvasAction model={model}/>
  </div><CanvasSearchPanel model={model} canvasId={model.canvasId}/></main>;
}

function emptyCanvasTitle(model: AppModel) {
  if (model.loading) return 'Loading your workspace…';
  if (model.canvasId) return 'Loading canvas…';
  return model.workspaces.length > 0 ? 'Your workspace is ready for a canvas' : 'One infinite canvas for people and AI';
}

function emptyCanvasDescription(model: AppModel) {
  if (model.canvasId) return 'Opening the canvas and its Markdown files.';
  return model.workspaces.length > 0 ? 'Create a canvas to start building connected knowledge.' : 'Create a workspace and start building connected knowledge together.';
}

function EmptyCanvasAction({ model }: { model: AppModel }) {
  if (model.canvasId || model.loading) return null;
  const hasWorkspace = model.workspaces.length > 0;
  return <button className="primary-button" onClick={() => model.openNamedDialog(hasWorkspace ? 'canvas' : 'workspace')}><Icon name="plus" size={17}/> {hasWorkspace ? 'Create canvas' : 'Create workspace'}</button>;
}
