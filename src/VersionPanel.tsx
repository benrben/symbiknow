import type { VersionPanelProps } from './version-panel-types';
import { versionBase } from './version-panel-types';
import { useVersionPanel } from './useVersionPanel';
import { VersionPanelView } from './VersionPanelView';

export type { VersionPanelProps } from './version-panel-types';

export function VersionPanel(props: VersionPanelProps) {
  return <DocumentVersions key={versionBase(props) + '#' + (props.initialRevision ?? '')} {...props} />;
}
function DocumentVersions(props: VersionPanelProps) {
  return <VersionPanelView model={useVersionPanel(props)} />;
}
