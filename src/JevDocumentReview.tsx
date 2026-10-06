import { useCallback, useEffect, useState } from 'react';
import type { SymbiActionName, SymbiActionState } from '../shared/symbi-contract';
import { jevActionLabels } from '../shared/jev-action-labels';
import { api } from './api';
import { groupDisplayPath } from './canvas-group-labels';
import './jev-document-review.css';

interface ReviewAction { action: SymbiActionName; state: SymbiActionState; reason?: string; role?: string;
  scores?: Array<{ name: string; value: number }> }
interface GroupingReview { groupKey: string; proposalId: string; confidence?: number; scores?: number[];
  status: 'pending' | 'applied' | 'held' | 'dismissed' | 'suppressed' | 'stale'; canApprove: boolean;
  reason?: string; evidence?: Array<{ quote: string }> }
interface DocumentReview { canvasId: string; blockId: string; contentHash: string; currentGroup?: string;
  durable: boolean; actions: ReviewAction[]; grouping?: GroupingReview }

const stateLabel = { waiting: 'Waiting', changed: 'Changed', no_change: 'No change', failed: 'Failed' } as const;
function score(value: number): string { return `${Math.round(value * 100)}%`; }

function currentHash(contentHash: string | undefined, reviewHash: string): boolean {
  return Boolean(contentHash) && contentHash === reviewHash;
}

function reviewStatus(review: DocumentReview | null): string {
  if (review?.durable) return 'Current checks saved';
  if (review?.actions.every(action => action.state === 'waiting')) return 'No checks recorded yet';
  return 'Checks in progress';
}

function ReviewActions({ actions }: { actions: ReviewAction[] }) {
  return <dl>{actions.map(action => <div key={action.action}>
    <dt>{jevActionLabels[action.action]}</dt>
    <dd>{stateLabel[action.state]}{action.role ? ` · ${action.role.replaceAll('_', ' ')}` : ''}
      {action.reason ? ` · ${action.reason}` : ''}
      {action.scores?.length ? <span className="jev-document-review__scores">Jev scores: {action.scores.map(item =>
        `${item.name.replaceAll('_', ' ')} ${score(item.value)}`).join(', ')}</span> : null}</dd>
  </div>)}</dl>;
}

function PendingGroupingAction({ grouping, busy, contentHash, reviewHash, onApprove }: {
  grouping: GroupingReview; busy: boolean;
  contentHash?: string; reviewHash: string; onApprove: () => void;
}) {
  if (!grouping.canApprove) return <small>Approval requires workspace review permission.</small>;
  return <button type="button" disabled={busy || !currentHash(contentHash, reviewHash)}
    onClick={onApprove}>Approve grouping</button>;
}

function GroupingOutcome({ grouping, busy, contentHash, reviewHash, onApprove }: {
  grouping: GroupingReview; busy: boolean; contentHash?: string; reviewHash: string; onApprove: () => void;
}) {
  if (grouping.status === 'pending') return <PendingGroupingAction grouping={grouping} busy={busy}
    contentHash={contentHash} reviewHash={reviewHash} onApprove={onApprove}/>;
  if (grouping.status === 'applied') return <small>Grouping saved</small>;
  if (grouping.status === 'held') return <small>{grouping.reason ?? 'Review the current evidence before grouping.'}</small>;
  return <small>This suggestion is no longer current.</small>;
}

function GroupScores({ grouping }: { grouping?: GroupingReview }) {
  if (grouping?.scores?.length) return <span className="jev-document-review__scores">Group checks: {grouping.scores.map(score).join(', ')}</span>;
  if (grouping?.confidence !== undefined) return <span className="jev-document-review__scores">Confidence {score(grouping.confidence)}</span>;
  return null;
}

function ReviewSummary({ review, groupLabels }: { review: DocumentReview; groupLabels?: Record<string, string> }) {
  const proposed = review.grouping?.status === 'pending' ? review.grouping.groupKey : undefined;
  const group = proposed ?? review.currentGroup;
  return <div className="jev-document-review__summary">
    <span>{proposed ? 'Suggested group' : 'Current group'}: <strong>{group ? groupDisplayPath(group, groupLabels) : 'Ungrouped'}</strong></span>
    <GroupScores grouping={review.grouping}/>
  </div>;
}

function ReviewDetails({ review, contentHash, groupLabels, busy, onApprove, onRecheck }: {
  review: DocumentReview; contentHash?: string; groupLabels?: Record<string, string>; busy: boolean;
  onApprove: () => void; onRecheck: () => void;
}) {
  return <>
    {contentHash !== review.contentHash && <p role="status">This document changed. Reload it before approving or rerunning Jev.</p>}
    <ReviewSummary review={review} groupLabels={groupLabels}/>
    <div className="jev-document-review__controls">
      {review.grouping && <GroupingOutcome grouping={review.grouping} busy={busy}
        contentHash={contentHash} reviewHash={review.contentHash} onApprove={onApprove}/>}
      <button type="button" disabled={busy || !currentHash(contentHash, review.contentHash)}
        aria-label="Run Jev again for this document" onClick={onRecheck}>{busy ? 'Saving…' : 'Run again'}</button>
      <details>
        <summary>Scores and evidence</summary>
        <div className="jev-document-review__detail-body">
          <ReviewActions actions={review.actions}/>
          {review.grouping?.evidence?.map((passage, index) => <blockquote key={index}>{passage.quote}</blockquote>)}
        </div>
      </details>
    </div>
  </>;
}

function canAct(review: DocumentReview | null, busy: boolean, contentHash: string | undefined): review is DocumentReview {
  return review !== null && !busy && currentHash(contentHash, review.contentHash);
}

function actionBody(review: DocumentReview, canvasId: string, operation: 'approve-group' | 'recheck') {
  return { canvasId, contentHash: review.contentHash,
    ...(operation === 'approve-group' ? { proposalId: review.grouping?.proposalId } : {}) };
}

function actionNotice(operation: 'approve-group' | 'recheck'): string {
  return operation === 'approve-group' ? 'Grouping approved and saved.' : 'Jev is checking this document again.';
}

export function JevDocumentReview({ workspaceId, canvasId, blockId, contentHash, groupLabels, onGroupChanged }: {
  workspaceId: string; canvasId: string; blockId: string; contentHash?: string;
  groupLabels?: Record<string, string>; onGroupChanged: () => Promise<void>;
}) {
  const [review, setReview] = useState<DocumentReview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const documentPath = `/workspaces/${encodeURIComponent(workspaceId)}/jev/documents/${encodeURIComponent(blockId)}`;
  const base = `${documentPath}/review`;
  const readReview = useCallback(async () => {
    const result = await api<DocumentReview>(`${base}?canvasId=${encodeURIComponent(canvasId)}`);
    if (result?.canvasId !== canvasId || result.blockId !== blockId || !Array.isArray(result.actions))
      throw new Error('Jev document decisions are unavailable for this source.');
    return result;
  }, [base, blockId, canvasId]);
  const load = useCallback(async () => {
    const result = await readReview();
    setReview(result); setError('');
  }, [readReview]);
  useEffect(() => {
    setReview(null); setNotice(''); setError('');
    let active = true;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const result = await readReview();
        if (active) { setReview(result); setError(''); }
      } catch (cause) { if (active) setError((cause as Error).message); }
    };
    void poll();
    const interval = window.setInterval(poll, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [readReview, contentHash]);

  async function act(operation: 'approve-group' | 'recheck') {
    if (!canAct(review, busy, contentHash)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = actionBody(review, canvasId, operation);
      await api(`${documentPath}/${operation}`, { method: 'POST', body: JSON.stringify(body) });
      if (operation === 'approve-group') await onGroupChanged();
      await load();
      setNotice(actionNotice(operation));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="jev-document-review" aria-label="Jev document decisions">
    <div className="jev-document-review__heading"><h2>Jev decisions</h2><span>{reviewStatus(review)}</span></div>
    {error && <p role="alert">{error} <button type="button" onClick={() => void load().catch(cause => setError((cause as Error).message))}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!review && !error && <p>Loading document decisions…</p>}
    {review && <ReviewDetails review={review} contentHash={contentHash} groupLabels={groupLabels} busy={busy}
      onApprove={() => void act('approve-group')} onRecheck={() => void act('recheck')}/>}
  </section>;
}
