import type { ChatSettings, WorkspaceSummary } from '../shared/types';
import { effectiveTokenScope } from './connection-scope';
import type { ConnectionTokenModel } from './useConnectionTokens';

export function ConnectionTokenList({ settings, workspaces, revoke }: { settings: ChatSettings; workspaces: WorkspaceSummary[] | null; revoke: ConnectionTokenModel['revoke'] }) {
  return <ul className="token-list">{settings.mcpTokens?.map(item => <li key={item.id}>
        <span><strong>{item.name}</strong><small>{item.preview}{` · ${item.access ?? 'write'} access`} · created {new Date(item.createdAt).toLocaleDateString()}{item.lastUsedAt ? ` · last used ${new Date(item.lastUsedAt).toLocaleString()}` : ' · not used yet'}</small>
          <small className="token-scope-summary">{effectiveTokenScope(item, workspaces)}</small></span>
        <button type="button" className="secondary-button" onClick={() => void revoke(item.id, item.name)}>Revoke</button></li>)}</ul>;
}
