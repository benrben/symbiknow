import { useEffect } from 'react';
import { api } from './api';
import { savedKeys, errorText } from './saved-investigation-keys';
import type { InvestigationRecord, InvestigationSummary, InvestigationProposalRef, SavedInvestigationsProps } from './saved-investigation-types';
import type { SavedInvestigationState } from './useSavedInvestigationState';
export function useSavedInvestigationOpen(props: SavedInvestigationsProps, state: SavedInvestigationState) {
  const { onOpen, openRequest, onOpenProposal } = props;
  const { owner, setBusy, setError, setReceipt, setUnreadableKey, setSelected, setTitle, setVisibility, setIsOpen } = state;
  async function open(item: Pick<InvestigationSummary, 'id'>) {
    const isOwner = owner();
    setUnreadableKey('');
    setBusy(true);
    setError('');
    setReceipt('');
    try {
      const key = savedKeys()[item.id];
      const record = await api<InvestigationRecord>('/investigations/' + encodeURIComponent(item.id),
        key ? { headers: { 'x-investigation-key': key } } : {});
      if (!isOwner()) return;
      setSelected(record);
      setTitle(record.title);
      setVisibility(record.visibility);
      onOpen(record);
      setReceipt('Opened ' + record.title + '. Save changes to update this investigation.');
    } catch (reason) { if (isOwner()) setError('Could not open investigation: ' + errorText(reason) + ' Refresh the list or check this browser’s private access key.'); }
    finally { if (isOwner()) setBusy(false); }
  }
  useEffect(() => {
    if (!openRequest) return;
    setIsOpen(true);
    void open(openRequest);
  }, [openRequest?.sequence]);
  async function openProposal(proposal: InvestigationProposalRef, record: InvestigationRecord) {
    if (!onOpenProposal) return;
    const isOwner = owner();
    setBusy(true);
    setError('');
    try {
      await onOpenProposal(proposal, record);
      if (isOwner()) setReceipt('Opened proposal ' + proposal.id + ' in Chat.');
    }
    catch (reason) { if (isOwner()) setError('Could not open proposal: ' + errorText(reason) + ' Ask Chat to prepare a fresh proposal if it expired.'); }
    finally { if (isOwner()) setBusy(false); }
  }
  return { open, openProposal };
}
