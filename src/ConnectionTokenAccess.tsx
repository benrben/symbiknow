import { toolsForAccess } from './connection-scope';
import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionTokenAccess({ model }: { model: ConnectionTokenModel }) {
  const { access, setAccess, setSelectedTools } = model;
  return <><label>Workspace access<select aria-label="Token access" value={access} onChange={event => {
          const nextAccess = event.target.value as typeof access;
          setAccess(nextAccess);
          if (nextAccess !== 'write') { model.setCanApprove(false); model.setCanConfigure(false); }
          const allowed = toolsForAccess(nextAccess, model.catalog, { canApprove: model.canApprove, canConfigure: model.canConfigure });
          setSelectedTools(tools => tools.filter(tool => allowed.includes(tool)));
        }}>
          <option value="read">Read only</option><option value="propose">Read and propose changes</option><option value="write">Read and make changes</option>
        </select><small>{access === 'read' ? 'Can read workspace documents.' : access === 'propose' ? 'Can read and propose edits for a person to approve.' : 'Can read and make workspace changes.'}</small></label>
    {access === 'write' && <fieldset><legend>Additional permissions</legend>
      <label><input type="checkbox" checked={model.canApprove} onChange={event => model.setCanApprove(event.target.checked)}/>Approve and undo proposals</label>
      <label><input type="checkbox" checked={model.canConfigure} onChange={event => model.setCanConfigure(event.target.checked)}/>Configure Symbi Reflex</label>
    </fieldset>}</>;
}
