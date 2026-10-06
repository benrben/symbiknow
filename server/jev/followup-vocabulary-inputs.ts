import { isDeepStrictEqual } from 'node:util';
import type { JevReceipt, JevVocabularyTerm, JevWorkspaceState } from '../../shared/jev-types.js';
import { automaticOrganizationReceipt } from './followup-receipt-origin.js';

type VocabularyReceipt = JevReceipt & { before: Extract<JevReceipt['before'], { kind: 'vocabulary' }>;
  after: Extract<JevReceipt['after'], { kind: 'vocabulary' }> };
type IndexedReceipt = { receipt: VocabularyReceipt; generated: boolean };

function vocabularyReceipt(receipt: JevReceipt): receipt is VocabularyReceipt {
  return receipt.state === 'applied' && receipt.before.kind === 'vocabulary' && receipt.after.kind === 'vocabulary'
    && receipt.before.term.id === receipt.after.term.id;
}
function originalTerm(term: JevVocabularyTerm, receipts: IndexedReceipt[]): JevVocabularyTerm | undefined {
  let baseline = term;
  for (const { receipt, generated } of receipts) {
    if (!generated || !isDeepStrictEqual(baseline, receipt.after.term) || receipt.after.operation === 'remove') break;
    if (receipt.before.operation === 'remove') return undefined;
    baseline = receipt.before.term;
  }
  return baseline;
}

/** Checked filing definitions are derived outputs; exact inverse chains retain manual vocabulary as checkpoint inputs. */
export function organizationVocabulary(state: JevWorkspaceState): JevVocabularyTerm[] {
  const proposals = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  const indexed = new Map<string, IndexedReceipt[]>();
  for (const receipt of state.receipts.slice().reverse()) {
    if (!vocabularyReceipt(receipt)) continue;
    const history = indexed.get(receipt.after.term.id) ?? [];
    history.push({ receipt, generated: receipt.action === 'file' && receipt.before.term.kind === 'group'
      && receipt.after.term.kind === 'group' && automaticOrganizationReceipt(receipt, proposals.get(receipt.proposalId)) });
    indexed.set(receipt.after.term.id, history);
  }
  return state.vocabulary.flatMap(term => {
    const baseline = originalTerm(term, indexed.get(term.id) ?? []);
    return baseline ? [baseline] : [];
  });
}
