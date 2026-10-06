import type { SavedInvestigationsProps } from './saved-investigation-types';
import { useSavedInvestigations } from './useSavedInvestigations';
import { SavedInvestigationForm } from './SavedInvestigationForm';
import { SavedInvestigationNotices } from './SavedInvestigationNotices';
import { SavedInvestigationList } from './SavedInvestigationList';
import { SavedInvestigationDetails } from './SavedInvestigationDetails';
import './saved-investigations.css';
export type {
  InvestigationMessage, InvestigationSourceRef, InvestigationSourceChange, InvestigationProposalRef,
  InvestigationResearchSnapshot, InvestigationRecord, SavedInvestigationsProps
} from './saved-investigation-types';
export function SavedInvestigations(props: SavedInvestigationsProps) {
  const model = useSavedInvestigations(props);
  return <section className="saved-investigations" aria-label="Saved investigations">
    <details open={model.isOpen} onToggle={event => model.setIsOpen(event.currentTarget.open)}><summary>Saved investigations <span>{model.items.length}</span></summary>
      {model.isOpen && <div className="saved-investigations__body">
        <p className="saved-investigations__access">Private access is saved in this browser’s local storage. Other browsers cannot reopen a private investigation without its access key. Shared investigations are visible to this workspace.</p>
        <SavedInvestigationForm model={model} /><SavedInvestigationNotices model={model} />
        <SavedInvestigationList model={model} /><SavedInvestigationDetails model={model} />
      </div>}
    </details>
  </section>;
}
