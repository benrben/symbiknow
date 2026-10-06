import { toolsForAccess } from './connection-scope';
import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionTokenAccess({ model }: { model: ConnectionTokenModel }) {
  const { access, setAccess, setSelectedTools } = model;
  return <label>Workspace access<select aria-label="Token access" value={access} onChange={event => {
          const nextAccess = event.target.value as typeof access;
          setAccess(nextAccess);
          const allowed = toolsForAccess(nextAccess);
          setSelectedTools(tools => tools.filter(tool => allowed.includes(tool)));
        }}>
          <option value="read">Read only</option><option value="propose">Read and propose changes</option><option value="write">Read and make changes</option>
        </select><small>{access === 'read' ? 'Can read workspace documents and tasks.' : access === 'propose' ? 'Can read and propose edits for a person to approve.' : 'Can read and make workspace changes.'}</small></label>;
}
