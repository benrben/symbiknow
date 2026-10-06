import type { SavedInvestigationsModel } from './useSavedInvestigations';
import { SavedInvestigationFreshness, SavedInvestigationComparison } from './SavedInvestigationFreshness';
import { SavedInvestigationSources, SavedInvestigationProposals } from './SavedInvestigationReferences';
export function SavedInvestigationDetails({ model }: { model: SavedInvestigationsModel }) {
  const { selected } = model;
  if (!selected) return null;
  return <div className="saved-investigations__detail" aria-label="Opened investigation details">
    <strong>{selected.title}</strong>
    <p>{selected.sourceRefs.length} source{selected.sourceRefs.length === 1 ? '' : 's'} · {selected.proposalRefs.length} proposal{selected.proposalRefs.length === 1 ? '' : 's'} · {selected.researchSnapshot?.turns.length ?? 0} research turns · revision {selected.revision}</p>
    <SavedInvestigationFreshness model={model} /><SavedInvestigationComparison model={model} />
    <SavedInvestigationSources model={model} /><SavedInvestigationProposals model={model} />
  </div>;
}
