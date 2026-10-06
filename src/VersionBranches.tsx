import type { VersionPanelModel } from './useVersionPanel';

export function VersionBranches({ model }: { model: VersionPanelModel }) {
  return <section className="version-panel__section" aria-label="Branches">
    <div className="version-panel__section-title">
      <h3>Branches</h3>
      <span className="version-panel__current">Current saved branch: {model.status?.current ?? (model.loadingStatus ? 'Loading…' : 'Unavailable')}</span>
    </div>
    <div className="version-panel__branch-list">
      {model.status?.branches.map(branch => <BranchButton key={branch} branch={branch} model={model} />)}
    </div>
    <CreateBranch model={model} />
    <MergeBranch model={model} />
  </section>;
}
function BranchButton({ branch, model }: { branch: string; model: VersionPanelModel }) {
  const current = branch === model.status!.current;
  return <button type="button" disabled={model.busy || current} className={current ? 'is-current' : ''}
    onClick={() => void model.choose({ kind: 'switch', value: branch, label: 'Switch to ' + branch })}>
    <span>⑂</span>{branch}{current && <small>Active</small>}
  </button>;
}
function CreateBranch({ model }: { model: VersionPanelModel }) {
  return <form className="version-panel__create" onSubmit={event => void model.create(event)}>
    <input aria-label="New branch name" placeholder="New branch name" value={model.name}
      onChange={event => model.setName(event.target.value)} disabled={model.busy || !model.status} />
    <button className="secondary-button" disabled={model.busy || !model.status || !model.name.trim()}>Create branch</button>
  </form>;
}
function MergeBranch({ model }: { model: VersionPanelModel }) {
  if (!model.otherBranches.length) return null;
  return <div className="version-panel__merge">
    <select aria-label="Branch to merge" value={model.target} onChange={event => model.setSelected(event.target.value)} disabled={model.busy}>
      {model.otherBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
    </select>
    <button type="button" className="secondary-button" disabled={model.busy}
      onClick={() => void model.choose({ kind: 'merge', value: model.target, label: 'Merge ' + model.target + ' into ' + model.status?.current })}>
      Preview merge into {model.status?.current}
    </button>
  </div>;
}
