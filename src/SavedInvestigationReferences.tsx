import type { SavedInvestigationsModel } from './useSavedInvestigations';
export function SavedInvestigationSources({ model }: { model: SavedInvestigationsModel }) {
  const { onOpenSource } = model;
  const selected = model.selected!;
  if (!selected.sourceRefs.length) return null;
  return <><h4>Sources</h4><ul>{selected.sourceRefs.map((source, index) => <li key={`${source.canvasId}:${source.blockId}:${index}`}>
    {onOpenSource ? <button type="button" onClick={() => onOpenSource(source)}>Open {source.canvasId} / {source.blockId}</button>
      : <span>{source.canvasId} / {source.blockId}</span>}
    {(source.revisionId || source.contentHash) && <small>{source.revisionId ? 'Revision ' + source.revisionId : 'Hash ' + source.contentHash}</small>}
  </li>)}</ul></>;
}
export function SavedInvestigationProposals({ model }: { model: SavedInvestigationsModel }) {
  const { onOpenProposal, openProposal, busy } = model;
  const selected = model.selected!;
  if (!selected.proposalRefs.length) return null;
  return <><h4>Proposals</h4><ul>{selected.proposalRefs.map((proposal, index) => <li key={`${proposal.kind}:${proposal.id}:${index}`}>
    <span>{proposal.kind} · {proposal.id}</span><small>{proposal.status ?? 'Status unknown'}</small>
    {proposal.kind === 'chat' && onOpenProposal && <button type="button" disabled={busy} onClick={() => void openProposal(proposal, selected)}>Review proposal in Chat</button>}
  </li>)}</ul></>;
}
