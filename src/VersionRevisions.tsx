import type { VersionPanelModel } from './useVersionPanel';
import type { Commit } from './version-panel-types';

function revisionCount(model: VersionPanelModel): string {
  if (model.status) return `${model.status.commits.length} shown`;
  return model.loadingStatus ? 'Loading…' : '';
}

export function VersionRevisions({ model }: { model: VersionPanelModel }) {
  return <section className="version-panel__section" aria-label="Revision history">
    <div className="version-panel__section-title">
      <h3>Recent revisions</h3><small>{revisionCount(model)}</small>
    </div>
    <ol className="version-panel__commits">
      {model.status?.commits.map(commit => <VersionCommit key={commit.id} commit={commit} model={model} />)}
    </ol>
  </section>;
}
function VersionCommit({ commit, model }: { commit: Commit; model: VersionPanelModel }) {
  return <li className={commit.id === model.initialRevision ? 'is-linked' : undefined}>
    <div>
      <strong>{commit.message}</strong>
      <small>{commit.author && <span className="version-panel__author">{commit.author}</span>}{commit.id.slice(0, 12)} · {new Date(commit.createdAt).toLocaleString()}</small>
    </div>
    <button type="button" disabled={model.busy}
      onClick={() => void model.choose({ kind: 'restore', value: commit.id, label: 'Restore ' + commit.id.slice(0, 12) })}>
      Inspect revision
    </button>
  </li>;
}
