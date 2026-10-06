import type { ChatSettings, WorkspaceSummary } from '../shared/types';
import { CopyButton } from './ConnectionCopy';
import { ConnectionCanvasScope } from './ConnectionCanvasScope';
import { ConnectionToolScope } from './ConnectionToolScope';
import { ConnectionTokenAccess } from './ConnectionTokenAccess';
import { ConnectionTokenList } from './ConnectionTokenList';
import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionTokenPanel({ model, settings, workspaces, workspaceError, loadWorkspaces }: { model: ConnectionTokenModel; settings: ChatSettings; workspaces: WorkspaceSummary[] | null; workspaceError: string; loadWorkspaces: () => Promise<void> }) {
  const { name, setName, created, error, scopeInvalid, creatingToken, createToken, revoke } = model;
  return <div className="connection-card">
      <div className="connection-card__top"><strong>Access tokens</strong><span className="connection-card__status"><TokenCount settings={settings}/></span></div>
      <p>Tokens take effect immediately, even when other Settings changes are pending. Each agent has its own access level, and its name appears as author in file history.</p>
      {/* Not a form: this sits inside the settings form, and forms cannot nest. */}
      <div className="token-form">
        <label>Token name<input aria-label="Token name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Ben’s laptop – Claude Code"
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createToken(); } }}/></label>
        <ConnectionTokenAccess model={model}/>
        <ConnectionCanvasScope model={model} workspaces={workspaces} workspaceError={workspaceError} loadWorkspaces={loadWorkspaces}/>
        <ConnectionToolScope model={model}/>
        <button type="button" className="primary-button" disabled={creatingToken || !name.trim() || scopeInvalid} onClick={() => void createToken()}>Create token</button>
      </div>
      {created && <div className="token-created" role="status"><strong>Copy this token now. It is shown once and never included in shared setup instructions.</strong><code>{created.token}</code><CopyButton text={created.token} label="Copy token"/></div>}
      {error && <p className="version-panel__error" role="alert">{error}</p>}
      <ConnectionTokenList settings={settings} workspaces={workspaces} revoke={revoke}/>
    </div>;
}

function TokenCount({ settings }: { settings: ChatSettings }) { return <>{settings.mcpTokens?.length ?? 0} active</>; }
