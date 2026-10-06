import type { CanvasBlock } from '../shared/types';
import type { ChatProposal, ChatProposalChange, ChatProposalReceipt, ChatProposalUndoReceipt } from './chatStream';
import type { DisplayTurn } from './chat-types';
import type { TurnMessageProps } from './chat-message-types';

type ProposalProps = Pick<TurnMessageProps, 'turn' | 'onSelectProposal' | 'onApplyProposal' | 'onUndoProposal'>;
export function ProposalReview(props: ProposalProps) {
  const { turn } = props;
  if (!turn.proposal) return null;
  return <section className="ai-chat__proposal" aria-label="Review proposed document changes">
    <ProposalHeader proposal={turn.proposal} state={turn.proposalState} />
    {turn.proposal.changes.map(change => <ProposalChange key={change.id} turn={turn} change={change} onSelectProposal={props.onSelectProposal} />)}
    {turn.proposalError && <p role="alert">{turn.proposalError}</p>}
    <ProposalControls {...props} /><ApplyReceipt receipt={turn.proposalReceipt} /><UndoReceipt receipt={turn.proposalUndoReceipt} />
    <ProposalUndoControl {...props} /><ProposalNextSteps state={turn.proposalState} />
  </section>;
}
function proposalHeading(state: DisplayTurn['proposalState']) {
  if (state === 'reverted') return 'Changes reverted';
  if (state === 'applied') return 'Changes applied';
  if (state === 'expired') return 'Proposal expired';
  if (state === 'failed') return 'No changes saved';
  return 'Review proposed changes';
}
function ProposalHeader({ proposal, state }: { proposal: ChatProposal; state: DisplayTurn['proposalState'] }) {
  return <><h3>{proposalHeading(state)}</h3>
    <p>{proposal.changes.length} proposed change{proposal.changes.length === 1 ? '' : 's'} on this canvas. Saved documents change only after Apply.</p>
    {proposal.expiresAt && state === 'pending' && <p>Available until {new Date(proposal.expiresAt).toLocaleString()}.</p>}</>;
}
function ProposalChange({ turn, change, onSelectProposal }: Pick<ProposalProps, 'turn' | 'onSelectProposal'> & { change: ChatProposalChange }) {
  return <div className="ai-chat__proposal-change">
    <label><ProposalSelection turn={turn} change={change} onSelectProposal={onSelectProposal} />
      <span><strong>{change.type} · {change.title}</strong><small>{change.before ? 'Existing document' : 'New document'} · {change.blockId}</small></span></label>
    {change.canApply === false && <p>This change cannot be applied from Chat. Use the document controls to make it.</p>}
    <details><summary>Inspect full before and after</summary><div className="ai-chat__proposal-compare">
      <div><strong>Before</strong><DocumentSnapshot block={change.before} empty="(new document)" /></div>
      <div><strong>After</strong><DocumentSnapshot block={change.after} empty="(removed document)" /></div>
    </div></details>
  </div>;
}
function ProposalSelection({ turn, change, onSelectProposal }: Pick<ProposalProps, 'turn' | 'onSelectProposal'> & { change: ChatProposalChange }) {
  return <input type="checkbox" checked={(turn.selectedProposalIds ?? []).includes(change.id)} disabled={turn.proposalState !== 'pending' || change.canApply === false}
    onChange={event => onSelectProposal(turn.id, change.id, event.currentTarget.checked)} />;
}
function DocumentSnapshot({ block, empty }: { block: CanvasBlock | null; empty: string }) {
  return <pre>{block ? JSON.stringify({ title: block.title, kind: block.kind, x: block.x, y: block.y, links: block.links }, null, 2) + '\n\n' + block.content : empty}</pre>;
}
function ProposalControls({ turn, onApplyProposal }: Pick<ProposalProps, 'turn' | 'onApplyProposal'>) {
  if (turn.proposalState === 'pending') return <button type="button" className="primary-button" disabled={!(turn.selectedProposalIds?.length)} onClick={() => onApplyProposal(turn.id)}>Apply selected ({turn.selectedProposalIds?.length ?? 0})</button>;
  if (turn.proposalState === 'applying') return <p role="status">Applying selected changes…</p>;
  return null;
}
function ApplyReceipt({ receipt }: { receipt?: ChatProposalReceipt }) {
  if (!receipt) return null;
  return <p role="status">{receipt.applied.length} change{receipt.applied.length === 1 ? '' : 's'} saved{receipt.skipped.length ? `; ${receipt.skipped.length} skipped` : ''}.
    {receipt.skipped.map(item => <span key={item.id}> {item.id}: {item.reason}</span>)}</p>;
}
function UndoReceipt({ receipt }: { receipt?: ChatProposalUndoReceipt }) {
  if (!receipt) return null;
  return <p role="status">{receipt.reverted.length} change{receipt.reverted.length === 1 ? '' : 's'} reverted{receipt.skipped?.length ? `; ${receipt.skipped.length} still applied` : ''}.
    {receipt.skipped?.map(item => <span key={item.id}> {item.id}: {item.reason}</span>)}</p>;
}
function ProposalUndoControl({ turn, onUndoProposal }: Pick<ProposalProps, 'turn' | 'onUndoProposal'>) {
  return turn.proposalState === 'applied' && <button type="button" className="secondary-button" onClick={() => onUndoProposal(turn.id)}>{turn.proposalUndoReceipt?.status === 'partial' ? 'Retry Undo for remaining changes' : 'Undo applied changes'}</button>;
}
function ProposalNextSteps({ state }: { state: DisplayTurn['proposalState'] }) {
  if (state === 'expired') return <p>Ask Chat to prepare a fresh proposal, then review the current documents before applying.</p>;
  if (state === 'reverted') return <p role="status">The applied changes were reverted. Review the current documents before proposing another change.</p>;
  return null;
}
