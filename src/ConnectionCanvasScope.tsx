import type { WorkspaceSummary } from '../shared/types';
import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionCanvasScope({ model, workspaces, workspaceError, loadWorkspaces }: { model: ConnectionTokenModel; workspaces: WorkspaceSummary[] | null; workspaceError: string; loadWorkspaces: () => Promise<void> }) {
  const { canvasScope, setCanvasScope } = model;
  return <>
        <label>Canvas scope<select aria-label="Canvas scope" value={canvasScope} onChange={event => setCanvasScope(event.target.value as typeof canvasScope)}>
          <option value="all">All canvases</option><option value="selected">Selected canvases</option>
        </select><small>{canvasScope === 'all' ? 'The token can access canvases across every workspace.' : 'The token is limited to the canvases selected below.'}</small></label>
        {canvasScope === 'selected' && <SelectedCanvasPicker model={model} workspaces={workspaces} workspaceError={workspaceError} loadWorkspaces={loadWorkspaces}/>}
  </>;
}

function SelectedCanvasPicker({ model, workspaces, workspaceError, loadWorkspaces }: { model: ConnectionTokenModel; workspaces: WorkspaceSummary[] | null; workspaceError: string; loadWorkspaces: () => Promise<void> }) {
  const { selectedCanvasIds, setSelectedCanvasIds } = model;
  return <div className="token-scope-picker" aria-label="Select canvases">
          <CanvasScopeStatus workspaces={workspaces} error={workspaceError} onRetry={loadWorkspaces}/>
          {workspaces?.flatMap(workspace => workspace.canvases.map(canvas => <label key={canvas.id}>
            <input type="checkbox" checked={selectedCanvasIds.includes(canvas.id)} disabled={!selectedCanvasIds.includes(canvas.id) && selectedCanvasIds.length >= 100}
              onChange={event => setSelectedCanvasIds(ids => event.target.checked ? [...ids, canvas.id] : ids.filter(id => id !== canvas.id))}/>{workspace.name} · {canvas.name}
          </label>))}

          {selectedCanvasIds.length === 0 && <small>Select at least one canvas.</small>}
          {selectedCanvasIds.length >= 100 && <small>Tokens can be limited to at most 100 canvases.</small>}
        </div>;
}

function CanvasScopeStatus({ workspaces, error, onRetry }: { workspaces: WorkspaceSummary[] | null; error: string; onRetry: () => Promise<void> }) {
  if (error) return <p role="alert">{error} <button type="button" className="activity-history-link" onClick={() => { void onRetry(); }}>Retry</button></p>;
  if (workspaces === null) return <p>Loading canvases…</p>;
  if (!workspaces.some(workspace => workspace.canvases.length)) return <p>No canvases are available.</p>;
  return null;
}
