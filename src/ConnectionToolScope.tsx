import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionToolScope({ model }: { model: ConnectionTokenModel }) {
  const { toolScope, setToolScope, availableTools, selectedTools, setSelectedTools } = model;
  return <>
        <label>Tool scope<select aria-label="Tool scope" value={toolScope} onChange={event => setToolScope(event.target.value as typeof toolScope)}>
          <option value="all">All tools allowed by access level</option><option value="selected">Selected tools</option>
        </select><small>{toolScope === 'all' ? 'Uses the full tool set permitted by the selected access level.' : 'Only checked tools will be available to this token.'}</small></label>
        {toolScope === 'selected' && <div className="token-scope-picker" aria-label="Select MCP tools">
          {availableTools.map(tool => <label key={tool}><input type="checkbox" checked={selectedTools.includes(tool)} onChange={event => setSelectedTools(tools => event.target.checked
            ? [...tools, tool] : tools.filter(item => item !== tool))}/>{tool}</label>)}
          {selectedTools.length === 0 && <small>Select at least one tool.</small>}
        </div>}
  </>;
}
