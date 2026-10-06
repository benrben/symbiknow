import type { JevProposal, JevReceipt } from '../../shared/jev-types.js';
import { trustedManagedOrigin } from './approval-origin.js';

/** Checked approvals retain their generated origin; corrections and Undo remain external inputs. */
export function automaticOrganizationReceipt(receipt: JevReceipt, proposal?: JevProposal): boolean {
  return receipt.state === 'applied' && !manualProposal(proposal)
    && (receipt.automatic === true || Boolean(proposal && trustedManagedOrigin(proposal)));
}
function manualProposal(proposal?: JevProposal): boolean {
  if (!proposal) return false;
  return proposal.reviewerEdited === true || ['override:', 'undo:'].some(prefix => proposal.jobId.startsWith(prefix));
}
