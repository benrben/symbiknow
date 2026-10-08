import type { ChatSettings } from '../shared/types';
import { ConnectionEndpoint } from './ConnectionEndpoint';
import { ConnectionTokenPanel } from './ConnectionTokenPanel';
import { ConnectionActivity } from './ConnectionActivity';
import { ConnectionClientSetup } from './ConnectionClientSetup';
import { useConnectionHealth } from './useConnectionHealth';
import { useConnectionTokens } from './useConnectionTokens';
import type { OpenActivityHistory } from './connection-types';
export type { OpenActivityHistory } from './connection-types';

export function ConnectAgents({ settings, onSettings, onOpenHistory }: { settings: ChatSettings; onSettings: (settings: ChatSettings) => void; onOpenHistory?: OpenActivityHistory }) {
  const health = useConnectionHealth();
  const tokens = useConnectionTokens(health.workspaces, onSettings, settings.mcpToolCatalog);
  return <>
    <ConnectionEndpoint info={health.info}/>
    <ConnectionTokenPanel model={tokens} settings={settings} workspaces={health.workspaces} workspaceError={health.workspaceError} loadWorkspaces={health.loadWorkspaces}/>
    <ConnectionActivity info={health.info} infoError={health.infoError} onRetryInfo={() => { void health.loadInfo(); }} onOpenHistory={onOpenHistory} workspaces={health.workspaces}/>
    <ConnectionClientSetup info={health.info} created={tokens.created}/>
  </>;
}
