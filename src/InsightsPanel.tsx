import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, Files, FileText, LayoutGrid, LoaderCircle, Network, Search, Sparkles, Tags, UsersRound, WandSparkles } from 'lucide-react';
import type { CanvasDocument, GroupBy } from '../shared/types';
import { canvasGrouping, type AutomationKind, type InsightAction, type InsightCategory, type InsightItem, type InsightReport, type RankedBlock, type ReadingPath } from '../shared/insights';
import { groupByLabels, groupTone } from '../shared/groups';
import { api } from './api';
import type { SymbiState } from './SymbiAvatar';
import type { FindingTaskReference } from './TasksPanel';
import './insights.css';

type JevActivityState = Extract<SymbiState, 'jev-analyzing' | 'jev-applying'>;
type InsightView = 'review' | 'groups' | 'connections' | 'labels' | 'duplicates' | 'more';

type InsightsPanelProps = {
  canvas: CanvasDocument | null;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onApply: (action: InsightAction) => Promise<void>;
  onOpenBlock: (blockId: string) => void;
  onMergeDraft?: (item: InsightItem, action: Extract<InsightAction, { type: 'merge' }>) => void;
  onDraftGap?: (item: InsightItem) => void;
  onCreateTask?: (item: InsightItem) => void;
  onStartPath?: (path: ReadingPath) => void;
  duplicateRequest?: { canvasId: string; blockId: string; sequence: number };
  targetedRequest?: { canvasId: string; blockIds: string[]; families?: string[]; sequence: number };
  /** Reload the canvas after a server-side automation changed it. */
  onChanged?: () => Promise<void> | void;
  groupBy?: GroupBy;
  onJevActivityChange?: (state: JevActivityState | null) => void;
  linkedFinding?: FindingTaskReference;
  groupsRequest?: number;
  onBrowseGroups?: () => void;
  onAdvancedGrouping?: () => void;
};

type WorkspaceKind = AutomationKind | 'dedupe' | 'tidy' | 'connect_all';
type WorkspaceChange = { id: string; canvasId: string; confidence: number; action: InsightAction; expectedContentHashes: Record<string, string>; requiresClick?: boolean };
type ChangeSet = { runId: string; workspaceId: string; kind: WorkspaceKind; dryRun: boolean; changes: WorkspaceChange[];
  groups: Array<{ canvasId: string; canvasName: string; count: number }>; applied?: string[]; skipped?: Array<{ id: string; reason: string }> };
type UndoReceipt = { reverted: string[]; skipped: Array<{ id: string; reason: string }> };
type JevInbox = { canvasId: string; items: InsightItem[]; checkedBlockIds: string[]; pendingBlockIds: string[]; errors: Array<{ blockId: string; message: string }> };

function validInbox(value: unknown): value is JevInbox {
  if (!value || typeof value !== 'object') return false;
  const inbox = value as Partial<JevInbox>;
  return typeof inbox.canvasId === 'string' && Array.isArray(inbox.items) && Array.isArray(inbox.checkedBlockIds)
    && Array.isArray(inbox.pendingBlockIds) && Array.isArray(inbox.errors);
}
type DuplicateCandidate = InsightItem & { action: Extract<InsightAction, { type: 'merge' }>; canvasIds: [string, string] };

const categoryLabels: Record<InsightCategory, string> = {
  connection: 'Connection',
  layout: 'Canvas layout',
  loader: 'Document type',
  purpose: 'Purpose',
  work_area: 'Work area',
  duplicate: 'Possible duplicate',
  conflict: 'Possible conflict',
  stale: 'May be outdated',
  missing_steps: 'Missing steps',
  reviewer: 'Reviewer',
  merge: 'Merge documents',
  cross_connection: 'Other canvas',
  relation: 'Relationship',
  supersedes: 'Supersedes',
  quality: 'Document quality',
  tag: 'Tag',
  task: 'Task',
  move: 'Move document',
  gap: 'Missing document',
};

type Automation = AutomationKind;

function percentage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
function changeCount(count: number): string { return `${count} change${count === 1 ? '' : 's'}`; }
function applyMessage(result: ChangeSet): string {
  const applied = result.applied?.length ?? 0;
  return result.skipped?.length ? `Applied ${changeCount(applied)}; skipped ${result.skipped.length}.`
    : `Applied ${changeCount(applied)}.`;
}
function undoMessage(result: UndoReceipt): string {
  return result.skipped.length ? `Reverted ${changeCount(result.reverted.length)}; skipped ${result.skipped.length}.`
    : `Reverted ${changeCount(result.reverted.length)}.`;
}
function operationError(action: 'preview' | 'apply' | 'undo', failure: unknown): string {
  const detail = errorText(failure);
  if (action === 'preview') return `Preview failed. Nothing was saved. Safe to retry. ${detail}`;
  if (action === 'apply') return `Apply failed. Saved state may have changed. Refresh and review the affected documents before retrying. ${detail}`;
  return `Undo failed. Some saved changes may remain or may already be reverted. Refresh and review the affected documents before retrying. ${detail}`;
}
function RunReceipt({ changes, completed, skipped, verb, scope }: { changes: WorkspaceChange[]; completed: string[];
  skipped: UndoReceipt['skipped']; verb: 'Applied' | 'Reverted'; scope: 'Canvas' | 'Workspace' }) {
  const titles = new Map(changes.map(change => [change.id, actionDescription(change.action)]));
  return <section className="insights-run-receipt" data-partial={skipped.length > 0} aria-label={`${scope} run receipt`}>
    <strong>{skipped.length ? 'Partial result' : verb}</strong>
    <p>{verb} {changeCount(completed.length)}; {skipped.length} skipped.</p>
    <ul>{completed.map(id => <li key={id}>{verb}: {titles.get(id) ?? id} <code>{id}</code></li>)}
      {skipped.map(item => <li key={item.id}>Skipped: {titles.get(item.id) ?? item.id} <code>{item.id}</code> — {item.reason}</li>)}</ul>
    {skipped.length > 0 && <p>{verb === 'Applied' ? 'Skipped changes were not saved.' : 'Skipped changes remain saved.'} Review current documents before preparing another preview.</p>}
  </section>;
}

function HealthTiles({ health }: { health: NonNullable<InsightReport['health']> }) {
  const tiles = [
    { label: 'Orphan docs', value: health.orphanRatio },
    { label: 'Duplicates', value: health.duplicateRatio },
    { label: 'Stale docs', value: health.staleRatio },
    { label: 'Mean quality', value: health.meanQuality },
    { label: 'Labels', value: health.labelCoverage },
  ];
  return <section className="insights-health" aria-label="Canvas health">
    {tiles.map(tile => <div className="insights-health__metric" key={tile.label}>
      <strong>{tile.value === null ? '—' : percentage(tile.value)}</strong>
      <span>{tile.label}</span>
    </div>)}
  </section>;
}

function RankedList({ title, description, items, onOpenBlock }: {
  title: string;
  description: string;
  items: RankedBlock[];
  onOpenBlock: (blockId: string) => void;
}) {
  return <section className="insights-section" aria-label={title}>
    <div className="insights-section__heading"><h3>{title}</h3><p>{description}</p></div>
    {items.length === 0 ? <p className="insights-empty-list">No documents to show.</p> : <ol className="insights-ranked-list">
      {items.map((item, index) => <li key={item.blockId}>
        <span className="insights-ranked-list__index">{index + 1}</span>
        <button type="button" onClick={() => onOpenBlock(item.blockId)} aria-label={`Open ${item.title}`}><FileText size={15} aria-hidden="true"/><span>{item.title}</span></button>
        {item.lane && <small className="insights-ranked-list__lane">{item.lane}</small>}
        <span className="insights-ranked-list__score" title={`${percentage(item.confidence)} confidence`}>{percentage(item.score)}</span>
      </li>)}
    </ol>}
  </section>;
}

function GroupCard({ group, total, onOpenBlock, titles }: { group: { key: string; label: string; blockIds: string[] }; total: number;
  onOpenBlock: (blockId: string) => void; titles: Map<string, string> }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.blockIds : group.blockIds.slice(0, 4);
  const hidden = group.blockIds.length - shown.length;
  return <article className={`insights-group insights-group--tone-${groupTone(group.key)}`}>
    <div className="insights-group__heading"><span className="insights-group__mark"/><strong>{group.label}</strong><span>{group.blockIds.length}</span></div>
    <div className="insights-group__bar" aria-hidden="true"><span style={{ width: `${Math.max(6, Math.round(group.blockIds.length / total * 100))}%` }}/></div>
    <div className="insights-group__docs">{shown.map(id => <button key={id} type="button" onClick={() => onOpenBlock(id)} title={`Open ${titles.get(id)}`}><FileText size={12} aria-hidden="true"/>{titles.get(id)}</button>)}
      {group.blockIds.length > 4 && <button type="button" className="insights-group__more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show less' : `Show ${hidden} more`}</button>}
    </div>
  </article>;
}

function GroupDashboard({ canvas, report, groupBy, onGroupBy, onOpenBlock, onPlace, placing, disabled }: {
  canvas: CanvasDocument;
  report: InsightReport | null;
  groupBy: GroupBy;
  onGroupBy: (value: GroupBy) => void;
  onOpenBlock: (blockId: string) => void;
  onPlace: () => void;
  placing: boolean;
  disabled: boolean;
}) {
  const groups = canvasGrouping(canvas.blocks, { classification: report?.classification, readingOrder: report?.readingOrder ?? [] }, groupBy);
  const titles = new Map(canvas.blocks.map(block => [block.id, block.title]));
  const unsorted = groups.find(group => group.key.endsWith(':other'))?.blockIds.length ?? 0;
  const laneUnknown = groupBy === 'lane' && !report?.classification?.some(entry => entry.lane) && !canvas.blocks.some(block => block.group?.startsWith('lane:') || ['overview', 'work', 'reference', 'followup'].includes(block.group ?? ''));
  const savedGroups = new Set(canvas.blocks.map(block => block.group).filter(Boolean));
  return <section className="insights-groups" aria-label="Document groups">
    <div className="insights-groups__top">
      <div className="insights-section__heading"><h3>Suggested groups</h3><p>{groups.length} inferred {groups.length === 1 ? 'group' : 'groups'} · {canvas.blocks.length} docs{unsorted ? ` · ${unsorted} not classified yet` : ''}</p></div>
      <div className="insights-groups__tabs" role="tablist" aria-label="Group documents by">{(Object.keys(groupByLabels) as GroupBy[]).map(value =>
        <button key={value} type="button" role="tab" aria-selected={groupBy === value} onClick={() => onGroupBy(value)}>{groupByLabels[value]}</button>)}</div>
    </div>
    <p className="insights-groups__hint">Saved canvas groups: {savedGroups.size}. These suggestions do not change the canvas until you review and apply the placement.</p>
    {laneUnknown && <p className="insights-groups__hint">Analyze the canvas to let Jev choose reading lanes.</p>}
    <div className="insights-groups__grid">{groups.map(group => <GroupCard key={group.key} group={group} total={canvas.blocks.length} titles={titles} onOpenBlock={onOpenBlock}/>)}</div>
    <button type="button" className="insights-groups__place" onClick={onPlace} disabled={disabled}>
      {placing ? <LoaderCircle size={14} className="insights-spin" aria-hidden="true"/> : <LayoutGrid size={14} aria-hidden="true"/>}
      Place these groups on the canvas</button>
  </section>;
}

function AffectedDoc({ blockId, canvas, onOpenBlock }: { blockId: string; canvas: CanvasDocument; onOpenBlock: (blockId: string) => void }) {
  const title = canvas.blocks.find(block => block.id === blockId)?.title ?? blockId;
  return <button type="button" onClick={() => onOpenBlock(blockId)} title={`Open ${title}`}><FileText size={13} aria-hidden="true"/>{title}</button>;
}

function ApplyButton({ applying, applied, busy, onClick, label = 'Apply suggestion' }: { applying: boolean; applied: boolean; busy: boolean; onClick: () => void; label?: string }) {
  return <button className="insights-card__apply" type="button" onClick={onClick} disabled={busy || applied}>
    {applying ? <LoaderCircle size={14} className="insights-spin" aria-hidden="true"/> : applied ? <Check size={14} aria-hidden="true"/> : <ArrowRight size={14} aria-hidden="true"/>}
    {applying ? 'Applying…' : applied ? 'Applied' : label}
  </button>;
}

function SuggestionCard({ item, canvas, applying, applied, dismissing, busy, onApply, onDismiss, onOpenBlock, onMergeDraft, onDraftGap, onCreateTask, mergeUnavailableReason, reviewOnly, onReview }: {
  item: InsightItem;
  canvas: CanvasDocument;
  applying: boolean;
  applied: boolean;
  dismissing: boolean;
  busy: boolean;
  onApply: (id: string, action: InsightAction) => void;
  onDismiss: (item: InsightItem) => void;
  onOpenBlock: (blockId: string) => void;
  onMergeDraft?: InsightsPanelProps['onMergeDraft'];
  onDraftGap?: InsightsPanelProps['onDraftGap'];
  onCreateTask?: InsightsPanelProps['onCreateTask'];
  mergeUnavailableReason?: string;
  reviewOnly?: boolean;
  onReview?: () => void;
}) {
  const action = item.action;
  const canApply = reviewOnly || action?.type === 'merge' ? undefined : action;
  const evidence = item.evidence?.filter(entry => entry.excerpt.trim()) ?? [];
  return <article className={`insights-card insights-card--${item.category}`}>
    <div className="insights-card__meta"><span>{categoryLabels[item.category]}</span><span title="Confidence">{percentage(item.confidence)} confident</span></div>
    <h4>{item.title}</h4>
    <p><strong>Why it matters:</strong> {item.detail}</p>
    {evidence.length > 0 && <div className="insights-card__passage"><strong>Affected passage</strong><blockquote>{evidence[0].excerpt}</blockquote></div>}
    {item.blockIds.length > 0 && <div className="insights-card__docs" aria-label="Affected documents">
      {item.blockIds.map(blockId => <AffectedDoc key={blockId} blockId={blockId} canvas={canvas} onOpenBlock={onOpenBlock}/>)}
    </div>}
    <p className="insights-card__confidence">Jev is {percentage(item.confidence)} confident. Check the source documents before accepting this suggestion.</p>
    {action && <p className="insights-card__proposal"><strong>Proposed change:</strong> {canvasActionDetails(action, canvas).join('; ')}</p>}
    {item.evidence?.length ? <details className="insights-card__evidence"><summary>Why? Evidence and technical details</summary>
      {item.evidence.map((entry, index) => <div key={`${entry.questionId}-${index}`}>
        <p>{entry.excerpt}</p><small>Jev answer: {entry.answer}</small><details><summary>Technical reference</summary><code>{entry.questionId}</code></details>
      </div>)}
    </details> : null}
    {mergeUnavailableReason && <p className="insights-card__note">{mergeUnavailableReason}</p>}
    <div className="insights-card__actions">
      {canApply && <ApplyButton applying={applying} applied={applied} busy={busy} onClick={() => onApply(item.id, canApply)} label={canApply.type === 'move' ? 'Move document' : undefined}/>}
      {reviewOnly && onReview && <button type="button" className="insights-card__apply" disabled={busy} onClick={onReview}>Review in analysis</button>}
      {action?.type === 'merge' && onMergeDraft && <button type="button" className="insights-card__apply" disabled={busy || applied} onClick={() => onMergeDraft(item, action)}>Merge in chat</button>}
      {item.category === 'gap' && onDraftGap && <button type="button" className="insights-card__apply" disabled={busy || applied} onClick={() => onDraftGap(item)}>Draft it in chat</button>}
      {onCreateTask && <button type="button" className="insights-card__task" disabled={busy} onClick={() => onCreateTask(item)}>Create task</button>}
      {!canApply && !reviewOnly && action?.type !== 'merge' && item.category !== 'gap' && item.blockIds.length > 0 &&
        <button type="button" className="insights-card__inspect" onClick={() => onOpenBlock(item.blockIds[0])}>Inspect document <ArrowRight size={13} aria-hidden="true"/></button>}
      <button type="button" className="insights-card__dismiss" disabled={busy || applied} onClick={() => onDismiss(item)}>{dismissing ? 'Dismissing…' : 'Dismiss'}</button>
    </div>
  </article>;
}

function SetupBanner({ hasApiKey, onOpenSettings }: Pick<InsightsPanelProps, 'hasApiKey' | 'onOpenSettings'>) {
  if (hasApiKey) return null;
  return <div className="insights-panel__setup"><p>Connect TypeSafe Jev in Settings to analyze this canvas.</p><button type="button" onClick={onOpenSettings}>Open Settings</button></div>;
}

function analysisButtonText(loading: boolean, hasReport: boolean): string {
  if (loading) return 'Analyzing…';
  return hasReport ? 'Analyze again' : 'Analyze canvas';
}

function AnalysisForm({ canvasId, hasApiKey, loading, hasReport, query, onQuery, onAnalyze, onQuickFocus }: {
  canvasId: string;
  hasApiKey: boolean;
  loading: boolean;
  hasReport: boolean;
  query: string;
  onQuery: (value: string) => void;
  onAnalyze: () => void;
  onQuickFocus: (families: string[]) => void;
}) {
  const unavailable = !canvasId || !hasApiKey || loading;
  return <form className="insights-panel__form" onSubmit={event => { event.preventDefault(); onAnalyze(); }}>
    <label htmlFor="insights-query">Focus your analysis <span>Optional</span></label>
    <div className="insights-panel__query"><Search size={16} aria-hidden="true"/><input id="insights-query" value={query} onChange={event => onQuery(event.currentTarget.value)} placeholder="e.g. onboarding docs" disabled={unavailable}/></div>
    <button className="insights-panel__analyze" type="submit" disabled={unavailable}>{loading ? <LoaderCircle size={15} className="insights-spin" aria-hidden="true"/> : <Sparkles size={15} aria-hidden="true"/>}{analysisButtonText(loading, hasReport)}</button>
    <div className="insights-panel__quick"><span>Or start with</span>
      <button type="button" disabled={unavailable} onClick={() => onQuickFocus(['links'])}>Connections</button>
      <button type="button" disabled={unavailable} onClick={() => onQuickFocus(['similarity', 'stale'])}>Conflicts</button>
      <button type="button" disabled={unavailable} onClick={() => onQuickFocus(['steps', 'gap'])}>Gaps</button>
    </div>
  </form>;
}

const workspaceKinds: Array<{ kind: WorkspaceKind; label: string }> = [
  { kind: 'tidy', label: 'Tidy documents' }, { kind: 'connect_all', label: 'Connect all canvases' },
  { kind: 'dedupe', label: 'Find duplicates' }, { kind: 'layout', label: 'Organize positions' },
  { kind: 'connection', label: 'Connect documents' }, { kind: 'cross_connect', label: 'Connect across canvases' },
  { kind: 'purpose', label: 'Label purposes' }, { kind: 'work_area', label: 'Classify work areas' },
  { kind: 'reviewer', label: 'Assign reviewers' }, { kind: 'regroup', label: 'Regroup and connect' },
];

function actionDescription(action: InsightAction): string {
  if (action.type === 'update') return `Update ${action.blockId}: ${Object.keys(action.patch).join(', ')}`;
  if (action.type === 'link') return `Link ${action.fromBlockId} → ${action.toBlockId}${action.relation ? ` (${action.relation.replaceAll('_', ' ')})` : ''}`;
  if (action.type === 'unlink') return `Remove link ${action.fromBlockId} → ${action.toBlockId}`;
  if (action.type === 'cross_link') return `Connect ${action.fromBlockId} → ${action.to.canvasId} / ${action.to.blockId}`;
  if (action.type === 'layout') return `Position ${action.positions.length} document${action.positions.length === 1 ? '' : 's'}`;
  if (action.type === 'merge') return `Merge ${action.mergeBlockIds.join(', ')} into ${action.keepBlockId}`;
  if (action.type === 'move') return `Move ${action.blockId} to ${action.toCanvasId}`;
  return `Update task ${action.taskId}`;
}

function canvasActionDetails(action: InsightAction, canvas: CanvasDocument): string[] {
  const title = (blockId: string) => canvas.blocks.find(block => block.id === blockId)?.title ?? blockId;
  if (action.type === 'link') return [`Add link: ${title(action.fromBlockId)} → ${title(action.toBlockId)}`];
  if (action.type === 'unlink') return [`Remove link: ${title(action.fromBlockId)} → ${title(action.toBlockId)}`];
  if (action.type === 'cross_link') return [`Connect ${title(action.fromBlockId)} to ${action.to.canvasId} / ${action.to.blockId}`];
  if (action.type === 'move') return [`Move ${title(action.blockId)} to canvas ${action.toCanvasId}`];
  if (action.type === 'layout') return action.positions.map(position => {
    const previous = canvas.blocks.find(block => block.id === position.blockId);
    const from = previous ? `(${Math.round(previous.x)}, ${Math.round(previous.y)})` : 'current position';
    return `${title(position.blockId)}: ${from} → (${Math.round(position.x)}, ${Math.round(position.y)})`;
  });
  if (action.type === 'update') return Object.entries(action.patch).map(([field, value]) => {
    const block = canvas.blocks.find(candidate => candidate.id === action.blockId);
    const before = block ? (block as unknown as Record<string, unknown>)[field] : undefined;
    const display = (input: unknown) => input == null || input === '' ? 'not set' : Array.isArray(input) ? input.join(', ') || 'none' : String(input);
    return `${title(action.blockId)} · ${field}: ${display(before)} → ${display(value)}`;
  });
  return [actionDescription(action)];
}

function WorkspaceAutomations({ canvas, hasApiKey, onChanged, onActivityChange }: Pick<InsightsPanelProps, 'canvas' | 'hasApiKey' | 'onChanged'> & { onActivityChange: (state: JevActivityState | null) => void }) {
  const workspaceId = canvas?.workspaceId ?? '';
  const [kind, setKind] = useState<WorkspaceKind>('tidy');
  const [preview, setPreview] = useState<ChangeSet | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const [undone, setUndone] = useState(false);
  const [undoReceipt, setUndoReceipt] = useState<UndoReceipt | null>(null);
  const [applyUncertain, setApplyUncertain] = useState(false);
  const [undoUncertain, setUndoUncertain] = useState(false);
  useEffect(() => onActivityChange(busy === 'preview' ? 'jev-analyzing' : busy ? 'jev-applying' : null), [busy, onActivityChange]);
  useEffect(() => () => onActivityChange(null), [onActivityChange]);
  useEffect(() => { setPreview(null); setSelected(new Set()); setMessage(''); setError(''); setApplied(false); setUndone(false); setUndoReceipt(null); setApplyUncertain(false); setUndoUncertain(false); }, [workspaceId]);

  async function previewChanges() {
    if (!workspaceId) return;
    setBusy('preview'); setError(''); setMessage(''); setPreview(null); setApplied(false); setUndone(false); setUndoReceipt(null); setApplyUncertain(false); setUndoUncertain(false);
    try {
      const result = await api<ChangeSet>(`/workspaces/${encodeURIComponent(workspaceId)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind, dryRun: true }),
      });
      if (result.workspaceId !== workspaceId) throw new Error('The preview belongs to another workspace.');
      setPreview(result);
      setSelected(new Set(result.changes.filter(change => !change.requiresClick).map(change => change.id)));
      setMessage(`Ready for review: ${changeCount(result.changes.length)} across ${result.groups.filter(group => group.count).length} canvas${result.groups.filter(group => group.count).length === 1 ? '' : 'es'}. Nothing saved yet.`);
    } catch (failure) { setError(operationError('preview', failure)); }
    finally { setBusy(''); }
  }

  async function applySelected() {
    if (!preview || !selected.size) return;
    setBusy('apply'); setError(''); setMessage('');
    try {
      const result = await api<ChangeSet>(`/workspaces/${encodeURIComponent(workspaceId)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind: preview.kind, dryRun: false, runId: preview.runId, actionIds: [...selected] }),
      });
      setPreview(result);
      setApplied(true);
      setMessage(applyMessage(result));
      try { await onChanged?.(); }
      catch { setError('Changes were saved, but the canvas did not refresh. Reload it to inspect the applied result.'); }
    } catch (failure) { setApplyUncertain(true); setError(operationError('apply', failure)); }
    finally { setBusy(''); }
  }

  async function undo() {
    if (!preview || !applied || undone) return;
    setBusy('undo'); setError(''); setMessage('');
    try {
      const result = await api<{ reverted: string[]; skipped: Array<{ id: string; reason: string }> }>(`/jev-runs/${encodeURIComponent(preview.runId)}/undo`, { method: 'POST' });
      setUndone(true); setUndoReceipt(result);
      setMessage(undoMessage(result));
      try { await onChanged?.(); }
      catch { setError('Undo completed, but the canvas did not refresh. Reload it to inspect the current result.'); }
    } catch (failure) { setUndoUncertain(true); setError(operationError('undo', failure)); }
    finally { setBusy(''); }
  }

  function toggle(ids: string[], checked: boolean) {
    setSelected(current => { const next = new Set(current); ids.forEach(id => checked ? next.add(id) : next.delete(id)); return next; });
  }

  return <section className="insights-section" aria-label="Workspace automations">
    <div className="insights-section__heading"><h3>Across the workspace</h3><p>Preview changes on every canvas, then choose which to apply.</p></div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <label>Workspace action<select aria-label="Workspace action" value={kind} disabled={Boolean(busy)} onChange={event => { setKind(event.target.value as WorkspaceKind); setPreview(null); setMessage(''); setError(''); setApplied(false); setUndone(false); setUndoReceipt(null); setApplyUncertain(false); setUndoUncertain(false); }}>
        {workspaceKinds.map(option => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select></label>
      <button type="button" className="insights-card__apply" disabled={!workspaceId || !hasApiKey || Boolean(busy)} onClick={() => void previewChanges()}>{busy === 'preview' ? 'Previewing…' : 'Preview workspace changes'}</button>
    </div>
    {busy && <p role="status">{busy === 'preview' ? 'Preparing workspace preview. Nothing is being saved.' : busy === 'apply' ? 'Applying selected workspace changes…' : 'Reverting saved workspace changes…'}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p className="insights-operation-error" role="alert">{error}</p>}
    {preview && <div aria-label="Workspace change preview">
      {preview.groups.filter(group => group.count).map(group => {
        const changes = preview.changes.filter(change => change.canvasId === group.canvasId);
        const eligible = changes.filter(change => !change.requiresClick).map(change => change.id);
        return <section key={group.canvasId} aria-label={`${group.canvasName} changes`} style={{ border: '1px solid var(--jev-border)', borderRadius: 8, padding: 10, marginTop: 9 }}>
          <label><input type="checkbox" aria-label={`Select all changes on ${group.canvasName}`} checked={eligible.length > 0 && eligible.every(id => selected.has(id))} disabled={applied || !eligible.length}
            onChange={event => toggle(eligible, event.currentTarget.checked)}/> <strong>{group.canvasName}</strong> · {changes.length} change{changes.length === 1 ? '' : 's'}</label>
          <div>{changes.map(change => <label key={change.id} style={{ display: 'block', marginTop: 7, paddingLeft: 12 }}>
            <input type="checkbox" aria-label={`Select ${actionDescription(change.action)}`} checked={selected.has(change.id)} disabled={applied || Boolean(change.requiresClick)}
              onChange={event => toggle([change.id], event.currentTarget.checked)}/> {actionDescription(change.action)} · {percentage(change.confidence)} confidence
            {canvas?.id === change.canvasId && <span className="insights-workspace-detail">{canvasActionDetails(change.action, canvas).join('; ')}</span>}
            {change.requiresClick && <small> · Review in chat before merging</small>}
            {preview.skipped?.find(entry => entry.id === change.id) && <small> · Skipped: {preview.skipped.find(entry => entry.id === change.id)?.reason}</small>}
          </label>)}</div>
        </section>;
      })}
      <p>{applied ? 'Saved run' : 'Ready for review'} · {selected.size} selected of {preview.changes.length} proposed changes</p>
      {!preview.changes.length && <p className="insights-empty-result">Jev checked the workspace canvases for this run and found no changes to apply.</p>}
      {!applied && preview.changes.length > 0 && <button type="button" className="insights-card__apply" disabled={!selected.size || Boolean(busy) || applyUncertain} onClick={() => void applySelected()}>{busy === 'apply' ? 'Applying…' : `Apply selected (${selected.size})`}</button>}
      {applied && !undone && Boolean(preview.applied?.length) && <button type="button" className="insights-card__apply" disabled={Boolean(busy) || undoUncertain} onClick={() => void undo()}>{busy === 'undo' ? 'Undoing…' : 'Undo this run'}</button>}
      {applied && !undone && <RunReceipt scope="Workspace" changes={preview.changes} completed={preview.applied ?? []} skipped={preview.skipped ?? []} verb="Applied"/>}
      {undone && undoReceipt && <RunReceipt scope="Workspace" changes={preview.changes} completed={undoReceipt.reverted} skipped={undoReceipt.skipped} verb="Reverted"/>}
    </div>}
  </section>;
}

function DuplicateFinder({ canvas, hasApiKey, dismissedIds, onDismiss, onOpenBlock, onMergeDraft, duplicateRequest, onActivityChange }: Pick<InsightsPanelProps, 'canvas' | 'hasApiKey' | 'onOpenBlock' | 'onMergeDraft' | 'duplicateRequest'> & {
  dismissedIds: Set<string>; onDismiss: (item: InsightItem) => void; onActivityChange: (state: JevActivityState | null) => void;
}) {
  const canvasId = canvas?.id ?? '';
  const [crossCanvas, setCrossCanvas] = useState(false);
  const [blockId, setBlockId] = useState('');
  const [items, setItems] = useState<DuplicateCandidate[] | null>(null);
  const [checkedScope, setCheckedScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => onActivityChange(loading ? 'jev-analyzing' : null), [loading, onActivityChange]);
  useEffect(() => () => onActivityChange(null), [onActivityChange]);
  useEffect(() => { setItems(null); setError(''); setBlockId(''); }, [canvasId]);
  useEffect(() => {
    if (duplicateRequest?.canvasId === canvasId && canvas?.blocks.some(block => block.id === duplicateRequest.blockId)) {
      setBlockId(duplicateRequest.blockId);
      void find(duplicateRequest.blockId);
    }
  }, [duplicateRequest?.sequence, canvasId]);

  async function find(targetBlockId = blockId) {
    if (!canvasId) return;
    setLoading(true); setError(''); setItems(null);
    try {
      const result = await api<DuplicateCandidate[]>(`/canvases/${encodeURIComponent(canvasId)}/duplicates`, {
        method: 'POST', body: JSON.stringify({ crossCanvas, ...(targetBlockId ? { blockId: targetBlockId } : {}) }),
      });
      setItems(result);
      setCheckedScope(targetBlockId ? `“${canvas?.blocks.find(block => block.id === targetBlockId)?.title ?? 'Selected document'}”` : `${canvas?.blocks.filter(block => !block.archived).length ?? 0} documents on this canvas`);
    } catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }

  return <section className="insights-section" aria-label="Find duplicates">
    <div className="insights-section__heading"><h3>Find duplicates</h3><p>Check overlapping documents before deciding whether to merge.</p></div>
    <label style={{ display: 'block' }}><input type="checkbox" aria-label="Include other canvases" checked={crossCanvas} onChange={event => { setCrossCanvas(event.currentTarget.checked); setItems(null); }}/> Include other canvases</label>
    <label style={{ display: 'block', marginTop: 7 }}>Document<select aria-label="Document to check for duplicates" value={blockId} onChange={event => { setBlockId(event.currentTarget.value); setItems(null); }}>
      <option value="">All documents</option>{canvas?.blocks.filter(block => !block.archived).map(block => <option key={block.id} value={block.id}>{block.title}</option>)}
    </select></label>
    <button type="button" className="insights-card__apply" disabled={!canvasId || !hasApiKey || loading} onClick={() => void find()}>{loading ? 'Checking…' : 'Find duplicates'}</button>
    {error && <p role="alert">{error}</p>}
    {items && <div aria-live="polite"><p>{items.filter(item => !dismissedIds.has(item.id)).length} possible duplicate{items.filter(item => !dismissedIds.has(item.id)).length === 1 ? '' : 's'}</p>
      {!items.filter(item => !dismissedIds.has(item.id)).length && <p className="insights-empty-result">Jev checked {checkedScope}{crossCanvas ? ' and other canvases' : ''}. No overlapping documents need review now. You can check a specific document or include other canvases.</p>}
      <div className="insights-card-list">{items.filter(item => !dismissedIds.has(item.id)).map(item => {
        const sameCanvas = item.canvasIds.every(id => id === canvasId);
        return <SuggestionCard key={item.id} item={item} canvas={canvas!} applying={false} applied={false} dismissing={false} busy={loading}
          onApply={() => undefined} onDismiss={onDismiss} onOpenBlock={onOpenBlock}
          onMergeDraft={sameCanvas ? onMergeDraft : undefined}
          mergeUnavailableReason={sameCanvas ? undefined : 'This pair spans canvases. Move the documents onto one canvas before merging.'}/>;
      })}</div>
    </div>}
  </section>;
}

function ErrorBanner({ error, errorAction, onRetry }: { error: string; errorAction: boolean; onRetry: () => void }) {
  if (!error) return null;
  return <div className="insights-panel__error" role="alert">{error}{!errorAction && <button type="button" onClick={onRetry}>Retry</button>}</div>;
}

function ReportResults({ report }: {
  report: InsightReport;
}) {
  return <div className="insights-panel__results" aria-live="polite">
    <div className="insights-panel__summary"><strong>{report.analyzed} of {report.total} docs analyzed</strong>{report.query && <span>Focus: {report.query}</span>}</div>
    {report.notice && <p className="insights-panel__notice">{report.notice}</p>}
    {report.health && <HealthTiles health={report.health}/>}
  </div>;
}

function ReportExplore({ report, canvas, onOpenBlock, onStartPath }: {
  report: InsightReport;
  canvas: CanvasDocument;
  onOpenBlock: (blockId: string) => void;
  onStartPath?: InsightsPanelProps['onStartPath'];
}) {
  return <details className="insights-secondary"><summary>Explore the analysis</summary><div className="insights-secondary__body">
    {Boolean(report.readingPaths?.length) && <section className="insights-section" aria-label="Reading paths">
      <div className="insights-section__heading"><h3>Reading paths</h3><p>Follow a focused sequence of documents.</p></div>
      <div className="insights-card-list">{report.readingPaths?.map(path => <article className="insights-card" key={path.id}>
        <h4>{path.name}</h4><p>{path.blockIds.length} documents</p>
        <button type="button" className="insights-card__apply" disabled={!onStartPath || !path.blockIds.some(id => canvas.blocks.some(block => block.id === id))} onClick={() => onStartPath?.(path)}>Start path</button>
      </article>)}</div>
    </section>}
    <RankedList title="Suggested reading order" description="A path through these documents" items={report.readingOrder} onOpenBlock={onOpenBlock}/>
    <RankedList title="Most relevant" description={report.query ? `Best matches for “${report.query}”` : 'Documents with the strongest signal'} items={report.relevance} onOpenBlock={onOpenBlock}/>
  </div></details>;
}

function ReportContent({ canvas, report, loading }: {
  canvas: CanvasDocument | null;
  report: InsightReport | null;
  loading: boolean;
}) {
  if (!canvas) return <div className="insights-panel__empty"><FileText size={24} aria-hidden="true"/><p>Open a canvas to see its insights.</p></div>;
  if (report) return <ReportResults report={report}/>;
  if (loading) return <p className="insights-panel__loading" role="status">Looking through this canvas…</p>;
  return null;
}

function automationUnavailable(canvas: CanvasDocument | null, hasApiKey: boolean, loading: boolean, applyingId: string) {
  return !canvas?.id || !hasApiKey || !canvas.blocks.length || loading || Boolean(applyingId);
}

export function InsightsPanel({ canvas, hasApiKey, onOpenSettings, onApply, onOpenBlock, onMergeDraft, onDraftGap, onCreateTask, onStartPath, duplicateRequest, targetedRequest, onChanged, onJevActivityChange, linkedFinding, groupsRequest, onBrowseGroups, onAdvancedGrouping, groupBy: initialGroupBy = 'work_area' }: InsightsPanelProps) {
  const canvasId = canvas?.id ?? '';
  const [groupBy, setGroupBy] = useState<GroupBy>(initialGroupBy);
  useEffect(() => setGroupBy(initialGroupBy), [initialGroupBy]);
  const [query, setQuery] = useState('');
  const [report, setReport] = useState<InsightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [applyingId, setApplyingId] = useState('');
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [uncertainIds, setUncertainIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState(false);
  const [automationMessage, setAutomationMessage] = useState('');
  const [canvasPreview, setCanvasPreview] = useState<ChangeSet | null>(null);
  const [selectedCanvasChanges, setSelectedCanvasChanges] = useState<Set<string>>(new Set());
  const [canvasChangesApplied, setCanvasChangesApplied] = useState(false);
  const [canvasChangesUndone, setCanvasChangesUndone] = useState(false);
  const [canvasUndoReceipt, setCanvasUndoReceipt] = useState<UndoReceipt | null>(null);
  const [canvasApplyUncertain, setCanvasApplyUncertain] = useState(false);
  const [canvasUndoUncertain, setCanvasUndoUncertain] = useState(false);
  const [inbox, setInbox] = useState<JevInbox | null>(null);
  const [inboxError, setInboxError] = useState('');
  const [activeTool, setActiveTool] = useState<InsightView>('review');
  const tabRefs = useRef<Partial<Record<InsightView, HTMLButtonElement | null>>>({});
  const [workspacePhase, setWorkspacePhase] = useState<JevActivityState | null>(null);
  const [duplicatePhase, setDuplicatePhase] = useState<JevActivityState | null>(null);
  const jevPhase: JevActivityState | null = workspacePhase ?? duplicatePhase
    ?? (applyingId ? applyingId.startsWith('automation-') && applyingId !== 'automation-apply' && applyingId !== 'automation-undo'
      ? 'jev-analyzing' : 'jev-applying' : loading ? 'jev-analyzing' : null);
  useEffect(() => { onJevActivityChange?.(jevPhase); }, [jevPhase, onJevActivityChange]);
  useEffect(() => () => onJevActivityChange?.(null), [onJevActivityChange]);
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const latestCanvasId = useRef(canvasId);
  latestCanvasId.current = canvasId;

  useEffect(() => {
    setReport(null);
    setError('');
    setErrorAction(false);
    setLoading(false);
    setApplyingId('');
    setAppliedIds(new Set());
    setUncertainIds(new Set());
    setDismissedIds(new Set());
    setAutomationMessage('');
    setCanvasPreview(null);
    setSelectedCanvasChanges(new Set());
    setCanvasChangesApplied(false);
    setCanvasChangesUndone(false);
    setCanvasUndoReceipt(null);
    setCanvasApplyUncertain(false);
    setCanvasUndoUncertain(false);
    setInbox(null);
    setInboxError('');
    setActiveTool('review');
    return () => {
      requestVersion.current++;
      activeRequest.current?.abort();
    };
  }, [canvasId]);
  useEffect(() => {
    if (groupsRequest) setActiveTool('groups');
  }, [groupsRequest]);

  const documentVersion = canvas?.blocks.map(block => `${block.id}:${block.contentHash ?? block.content}`).join('|') ?? '';
  useEffect(() => {
    if (!canvasId || !hasApiKey) return;
    const controller = new AbortController();
    api<JevInbox>(`/canvases/${encodeURIComponent(canvasId)}/jev-inbox`, { signal: controller.signal })
      .then(result => { if (!validInbox(result)) throw new Error('Invalid inbox response.'); if (!controller.signal.aborted && result.canvasId === canvasId) { setInbox(result); setInboxError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setInboxError(errorText(failure)); });
    return () => controller.abort();
  }, [canvasId, hasApiKey, documentVersion]);

  const pendingInboxIds = inbox?.pendingBlockIds.join('|') ?? '';
  useEffect(() => {
    if (!canvasId || !hasApiKey || !pendingInboxIds || inboxError) return;
    const timer = window.setTimeout(() => void refreshInbox(canvasId), 250);
    return () => window.clearTimeout(timer);
  }, [canvasId, hasApiKey, pendingInboxIds, inboxError]);

  async function refreshInbox(target = canvasId, retry = false) {
    try {
      const result = await api<JevInbox>(`/canvases/${encodeURIComponent(target)}/jev-inbox${retry ? '?retry=1' : ''}`);
      if (!validInbox(result)) throw new Error('Invalid inbox response.');
      if (latestCanvasId.current === target && result.canvasId === target) { setInbox(result); setInboxError(''); setUncertainIds(new Set()); }
    } catch (failure) {
      if (latestCanvasId.current === target) setInboxError(errorText(failure));
    }
  }

  function canAnalyze() {
    return Boolean(canvasId && hasApiKey && latestCanvasId.current === canvasId);
  }

  function isCurrentAnalysis(version: number, resultCanvasId: string) {
    return version === requestVersion.current && resultCanvasId === canvasId && latestCanvasId.current === canvasId;
  }

  function handleAnalysisError(version: number, controller: AbortController, failure: unknown) {
    if (isCurrentAnalysis(version, canvasId) && !controller.signal.aborted) setError(errorText(failure));
  }

  function finishAnalysis(version: number) {
    if (!isCurrentAnalysis(version, canvasId)) return;
    activeRequest.current = null;
    setLoading(false);
  }

  async function analyze(target?: { blockIds?: string[]; families?: string[] }): Promise<InsightReport | null> {
    if (!canAnalyze()) return null;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    setErrorAction(false);
    try {
      const result = await api<InsightReport>(`/canvases/${encodeURIComponent(canvasId)}/insights`, {
        method: 'POST',
        body: JSON.stringify({ query, ...(target?.blockIds ? { blockIds: target.blockIds } : {}),
          ...(target?.families ? { families: target.families } : {}) }),
        signal: controller.signal,
      });
      if (isCurrentAnalysis(version, result.canvasId)) {
        setReport(result);
        setUncertainIds(new Set());
        return result;
      }
    } catch (failure) {
      handleAnalysisError(version, controller, failure);
    } finally {
      finishAnalysis(version);
    }
    return null;
  }

  useEffect(() => {
    if (targetedRequest?.canvasId === canvasId && targetedRequest.blockIds.length && hasApiKey) {
      switchView('review');
      void analyze({ blockIds: targetedRequest.blockIds, families: targetedRequest.families });
    }
  }, [targetedRequest?.sequence, canvasId]);

  useEffect(() => {
    if (duplicateRequest?.canvasId === canvasId) switchView('duplicates');
  }, [duplicateRequest?.sequence, canvasId]);

  /** A canvas automation starts as a reviewable, unchanged preview. */
  async function runAutomation(automation: Automation): Promise<void> {
    const target = canvasId;
    switchView(automation === 'layout' || automation === 'regroup' ? 'groups'
      : automation === 'connection' || automation === 'cross_connect' ? 'connections' : 'labels');
    setApplyingId(`automation-${automation}`);
    setAutomationMessage('');
    setError('');
    setCanvasPreview(null);
    setCanvasChangesApplied(false);
    setCanvasChangesUndone(false);
    setCanvasUndoReceipt(null);
    setCanvasApplyUncertain(false);
    setCanvasUndoUncertain(false);
    try {
      const grouped = automation === 'layout' || automation === 'regroup';
      const result = await api<ChangeSet>(`/canvases/${encodeURIComponent(target)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind: automation, dryRun: true, ...(grouped ? { groupBy } : {}) }),
      });
      if (latestCanvasId.current !== target) return;
      setCanvasPreview(result);
      setSelectedCanvasChanges(new Set(result.changes.filter(change => !change.requiresClick).map(change => change.id)));
      setAutomationMessage(`Ready for review: ${changeCount(result.changes.length)}. Nothing saved yet.`);
    } catch (failure) {
      if (latestCanvasId.current === target) {
        setError(operationError('preview', failure));
        setErrorAction(true);
      }
    } finally {
      if (latestCanvasId.current === target) setApplyingId('');
    }
  }

  async function applyCanvasChanges() {
    if (!canvasPreview || !selectedCanvasChanges.size || applyingId) return;
    const target = canvasId;
    setApplyingId('automation-apply'); setError(''); setAutomationMessage('');
    try {
      const result = await api<ChangeSet>(`/canvases/${encodeURIComponent(target)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind: canvasPreview.kind, dryRun: false, runId: canvasPreview.runId, actionIds: [...selectedCanvasChanges] }),
      });
      if (latestCanvasId.current !== target) return;
      setCanvasPreview(result); setCanvasChangesApplied(true); setReport(null);
      setAutomationMessage(applyMessage(result));
      try { await onChanged?.(); }
      catch { setError('Changes were saved, but the canvas did not refresh. Reload it to inspect the applied result.'); setErrorAction(true); }
      void refreshInbox(target);
    } catch (failure) { if (latestCanvasId.current === target) { setCanvasApplyUncertain(true); setError(operationError('apply', failure)); setErrorAction(true); } }
    finally { if (latestCanvasId.current === target) setApplyingId(''); }
  }

  async function undoCanvasChanges() {
    if (!canvasPreview || !canvasChangesApplied || canvasChangesUndone || applyingId) return;
    const target = canvasId;
    setApplyingId('automation-undo'); setError(''); setAutomationMessage('');
    try {
      const result = await api<UndoReceipt>(`/jev-runs/${encodeURIComponent(canvasPreview.runId)}/undo`, { method: 'POST' });
      if (latestCanvasId.current !== target) return;
      setCanvasChangesUndone(true); setCanvasUndoReceipt(result);
      setAutomationMessage(undoMessage(result));
      try { await onChanged?.(); }
      catch { setError('Undo completed, but the canvas did not refresh. Reload it to inspect the current result.'); setErrorAction(true); }
      void refreshInbox(target);
    } catch (failure) { if (latestCanvasId.current === target) { setCanvasUndoUncertain(true); setError(operationError('undo', failure)); setErrorAction(true); } }
    finally { if (latestCanvasId.current === target) setApplyingId(''); }
  }

  function toggleCanvasChanges(ids: string[], checked: boolean) {
    setSelectedCanvasChanges(previous => {
      const next = new Set(previous);
      ids.forEach(id => checked ? next.add(id) : next.delete(id));
      return next;
    });
  }

  function switchView(view: InsightView) {
    setActiveTool(view);
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, view: InsightView) {
    const views: InsightView[] = ['review', 'groups', 'connections', 'labels', 'duplicates', 'more'];
    const index = views.indexOf(view);
    const next = event.key === 'ArrowRight' ? views[(index + 1) % views.length]
      : event.key === 'ArrowLeft' ? views[(index + views.length - 1) % views.length]
        : event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    switchView(next);
    tabRefs.current[next]?.focus();
  }

  async function actOnInbox(item: InsightItem, decision: 'apply' | 'dismiss') {
    if (applyingId) return;
    const target = canvasId;
    setApplyingId(`inbox-${item.id}`); setError('');
    try {
      const result = await api<JevInbox>(`/canvases/${encodeURIComponent(target)}/jev-inbox/${encodeURIComponent(item.id)}/${decision}`, { method: 'POST' });
      if (!validInbox(result)) throw new Error('Invalid inbox response.');
      if (latestCanvasId.current !== target) return;
      setInbox(result);
      if (decision === 'apply') {
        try { await onChanged?.(); }
        catch { setError('Suggestion was saved, but the canvas did not refresh. Reload it to inspect the result.'); setErrorAction(true); }
      }
    } catch (failure) { if (latestCanvasId.current === target) { if (decision === 'apply') setUncertainIds(previous => new Set(previous).add(item.id));
      setError(decision === 'apply' ? operationError('apply', failure) : errorText(failure)); setErrorAction(true); } }
    finally { if (latestCanvasId.current === target) setApplyingId(''); }
  }

  async function recordFeedback(target: string, item: InsightItem, decision: 'applied' | 'dismissed'): Promise<void> {
    await api(`/canvases/${encodeURIComponent(target)}/insights/feedback`, {
      method: 'POST',
      body: JSON.stringify({ itemId: item.id, category: item.category, confidence: item.confidence, decision }),
    });
  }

  async function dismiss(item: InsightItem): Promise<void> {
    if (applyingId) return;
    const target = canvasId;
    setApplyingId(`dismiss-${item.id}`);
    setError('');
    try {
      await recordFeedback(target, item, 'dismissed');
      if (latestCanvasId.current === target) setDismissedIds(previous => new Set(previous).add(item.id));
    } catch (failure) {
      if (latestCanvasId.current === target) {
        setError(`Could not dismiss suggestion. ${errorText(failure)}`);
        setErrorAction(true);
      }
    } finally {
      if (latestCanvasId.current === target) setApplyingId('');
    }
  }

  async function apply(id: string, action: InsightAction) {
    if (applyingId) return;
    const target = canvasId;
    const item = report?.items.find(candidate => candidate.id === id);
    setApplyingId(id);
    setError('');
    try {
      await onApply(action);
      if (latestCanvasId.current === target) setAppliedIds(previous => new Set(previous).add(id));
      let feedbackFailure: unknown;
      if (item) {
        try { await recordFeedback(target, item, 'applied'); }
        catch (failure) { feedbackFailure = failure; }
      }
      if (latestCanvasId.current !== target) return;
      await analyze();
      if (feedbackFailure) {
        setError(`Change applied, but feedback could not be saved. ${errorText(feedbackFailure)}`);
        setErrorAction(true);
      }
    } catch (failure) {
      if (latestCanvasId.current === target) {
        setUncertainIds(previous => new Set(previous).add(id));
        setError(operationError('apply', failure));
        setErrorAction(true);
      }
    } finally {
      if (latestCanvasId.current === target) setApplyingId('');
    }
  }

  const currentReport = report?.canvasId === canvasId ? report : null;
  const inboxItems = inbox?.canvasId === canvasId ? inbox.items.filter(item => !dismissedIds.has(item.id)) : [];
  const reportItems = currentReport?.items.filter(item => !dismissedIds.has(item.id) && !inboxItems.some(inboxItem => inboxItem.id === item.id)) ?? [];
  const readyItems = reportItems.filter(item => Boolean(item.action) || item.category === 'gap');
  const checkItems = reportItems.filter(item => !readyItems.includes(item));
  const renderReportItems = (items: InsightItem[]) => items.map(item => <SuggestionCard key={item.id} item={item} canvas={canvas!} applying={applyingId === item.id} applied={appliedIds.has(item.id)} dismissing={applyingId === `dismiss-${item.id}`} busy={Boolean(applyingId) || uncertainIds.has(item.id)} onApply={(id, action) => void apply(id, action)} onDismiss={item => void dismiss(item)} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} onDraftGap={onDraftGap} onCreateTask={onCreateTask}/>);

  const previewPanel = canvasPreview && canvas && <section className="insights-preview" aria-label="Canvas change preview">
    <h3>{canvasChangesUndone ? canvasUndoReceipt?.skipped.length ? 'Partially reverted' : 'Run reverted'
      : canvasChangesApplied ? canvasPreview.skipped?.length ? 'Partially applied' : 'Applied changes' : 'Ready for review'}</h3>
    <p>{selectedCanvasChanges.size} selected of {canvasPreview.changes.length} proposed changes. {canvasChangesApplied
      ? 'Review the receipt below against the current canvas.' : 'This is a list preview. Nothing is saved until Apply.'}</p>
    <div className="insights-preview__list">{canvasPreview.changes.map(change => <label key={change.id}>
      <input type="checkbox" aria-label={`Select ${actionDescription(change.action)}`} checked={selectedCanvasChanges.has(change.id)} disabled={canvasChangesApplied || Boolean(change.requiresClick)} onChange={event => toggleCanvasChanges([change.id], event.currentTarget.checked)}/>
      <span><strong>{actionDescription(change.action)}</strong>{canvasActionDetails(change.action, canvas).map(detail => <em key={detail}>{detail}</em>)}<small>{percentage(change.confidence)} confidence{change.requiresClick ? ' · Review in chat first' : ''}{canvasPreview.skipped?.find(entry => entry.id === change.id) ? ` · Skipped: ${canvasPreview.skipped.find(entry => entry.id === change.id)?.reason}` : ''}</small></span>
    </label>)}</div>
    {!canvasPreview.changes.length && <p className="insights-empty-result">Jev checked this canvas for the selected action and found no proposed changes. Nothing was saved.</p>}
    {!canvasChangesApplied && canvasPreview.changes.length > 0 && <button type="button" className="insights-preview__primary" disabled={!selectedCanvasChanges.size || Boolean(applyingId) || canvasApplyUncertain} onClick={() => void applyCanvasChanges()}>{applyingId === 'automation-apply' ? 'Applying…' : `Apply selected (${selectedCanvasChanges.size})`}</button>}
    {canvasChangesApplied && !canvasChangesUndone && Boolean(canvasPreview.applied?.length) && <button type="button" className="insights-preview__undo" disabled={Boolean(applyingId) || canvasUndoUncertain} onClick={() => void undoCanvasChanges()}>{applyingId === 'automation-undo' ? 'Undoing…' : 'Undo this run'}</button>}
    {canvasChangesApplied && !canvasChangesUndone && <RunReceipt scope="Canvas" changes={canvasPreview.changes} completed={canvasPreview.applied ?? []} skipped={canvasPreview.skipped ?? []} verb="Applied"/>}
    {canvasChangesUndone && canvasUndoReceipt && <RunReceipt scope="Canvas" changes={canvasPreview.changes} completed={canvasUndoReceipt.reverted} skipped={canvasUndoReceipt.skipped} verb="Reverted"/>}
    {canvasChangesUndone && !canvasUndoReceipt?.skipped.length && <p className="insights-preview__receipt" role="status">This run was reverted. Review current canvas content before starting another run.</p>}
  </section>;

  return <div ref={panelRef} className="insights-panel">
    <div className={`insights-panel__start${activeTool !== 'review' || inboxItems.length + reportItems.length > 0 ? ' insights-panel__start--compact' : ''}`}>
      <div className="insights-panel__intro"><div className="insights-panel__icon"><Sparkles size={21} aria-hidden="true"/></div><div className="insights-panel__identity"><span className="insights-panel__eyebrow">YOUR CANVAS COPILOT</span><h2>Jev insights</h2><p>See what connects, what conflicts, and what needs a decision.</p>{jevPhase && <span className="insights-panel__jev-status" aria-live="polite">Jev is {jevPhase === 'jev-applying' ? 'applying the canvas changes' : 'analyzing the documents'}…</span>}</div></div>
      {activeTool === 'review' && <AnalysisForm canvasId={canvasId} hasApiKey={hasApiKey} loading={loading || Boolean(applyingId)} hasReport={Boolean(currentReport)} query={query} onQuery={setQuery} onAnalyze={() => void analyze()} onQuickFocus={families => void analyze({ families })}/>}
    </div>
    <div className="insights-tools" role="tablist" aria-label="Jev views">
      {([
        ['review', 'Review', Sparkles], ['groups', 'Groups', LayoutGrid], ['connections', 'Connections', Network],
        ['labels', 'Labels', Tags], ['duplicates', 'Duplicates', Files], ['more', 'More', WandSparkles],
      ] as const).map(([view, label, Icon]) => <button key={view} ref={element => { tabRefs.current[view] = element; }} type="button" role="tab" aria-label={label} aria-selected={activeTool === view} aria-controls={`jev-panel-${view}`} tabIndex={activeTool === view ? 0 : -1} onKeyDown={event => onTabKeyDown(event, view)} onClick={() => switchView(view)} title={label}>
        <Icon size={18} aria-hidden="true"/><span>{label}</span>{view === 'review' && inboxItems.length + reportItems.length > 0 &&
          <small className="insights-tools__badge" aria-hidden="true">{inboxItems.length + reportItems.length}</small>}
      </button>)}
    </div>
    <p className="insights-tools__selected" aria-live="polite">{activeTool === 'more' ? 'Workspace runs' : activeTool[0].toUpperCase() + activeTool.slice(1)}</p>
    <SetupBanner hasApiKey={hasApiKey} onOpenSettings={onOpenSettings}/>
    <ErrorBanner error={error} errorAction={errorAction} onRetry={() => void analyze()}/>
    {applyingId.startsWith('automation-') && <p className="insights-operation-progress" role="status">{applyingId === 'automation-apply'
      ? 'Applying selected canvas changes…' : applyingId === 'automation-undo' ? 'Reverting saved canvas changes…'
        : 'Preparing canvas preview. Nothing is being saved.'}</p>}
    {activeTool === 'review' && <div id="jev-panel-review" className="insights-review-view" role="tabpanel" aria-label="Review view">
      {linkedFinding?.canvasId === canvasId && <section className="insights-linked-finding" aria-label="Finding linked from Tasks">
        <small>LINKED FROM TASKS</small><h3>{linkedFinding.title}</h3>
        {linkedFinding.detail && <p>{linkedFinding.detail}</p>}
        {linkedFinding.evidence?.map((entry, index) => <blockquote key={`${entry.questionId}-${index}`}>{entry.excerpt}</blockquote>)}
        {linkedFinding.references?.map((entry, index) => <blockquote key={`${entry.documentId}-${index}`}>{entry.passageLabel ?? entry.passage}</blockquote>)}
        <div>{linkedFinding.blockIds.map(id => <button type="button" key={id} onClick={() => onOpenBlock(id)}>Open {canvas?.blocks.find(block => block.id === id)?.title ?? id}</button>)}</div>
      </section>}
      <ReportContent canvas={canvas} report={currentReport} loading={loading}/>
      {canvas && hasApiKey && <section className="insights-inbox insights-section" aria-label="Suggestions">
      <div className="insights-section__heading"><span className="insights-section__eyebrow">YOUR DECISIONS</span><h3>Review <span>{inboxItems.length + reportItems.length}</span></h3><p>Findings stay here until you decide what to do.</p></div>
      {inboxError && <p className="insights-inbox__error" role="alert">Inbox unavailable: {inboxError} <button type="button" onClick={() => void refreshInbox()}>Retry</button></p>}
      {inbox?.pendingBlockIds.length ? <p className="insights-inbox__status">Checking {inbox.pendingBlockIds.length} changed document{inbox.pendingBlockIds.length === 1 ? '' : 's'}.</p> : null}
      {inbox?.errors.length ? <p className="insights-inbox__status">{inbox.errors.length} document{inbox.errors.length === 1 ? '' : 's'} could not be checked. <button type="button" onClick={() => void refreshInbox(canvasId, true)}>Retry</button></p> : null}
      {inboxItems.length + reportItems.length ? <div className="insights-review-groups">
      {inboxItems.length > 0 && <div><h4>New findings <span>{inboxItems.length}</span></h4><div className="insights-card-list">{inboxItems.map(item => <SuggestionCard key={item.id} item={item} canvas={canvas} applying={applyingId === `inbox-${item.id}`} applied={false} dismissing={applyingId === `inbox-${item.id}`} busy={Boolean(applyingId) || uncertainIds.has(item.id)} onApply={() => void actOnInbox(item, 'apply')} onDismiss={() => void actOnInbox(item, 'dismiss')} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} onDraftGap={onDraftGap} onCreateTask={onCreateTask}
          reviewOnly={item.action?.type === 'move' || item.action?.type === 'layout'} onReview={() => void analyze({ blockIds: item.blockIds.slice(0, 2) })}/>)}</div></div>}
        {readyItems.length > 0 && <div><h4>Ready to act <span>{readyItems.length}</span></h4><div className="insights-card-list">{renderReportItems(readyItems)}</div></div>}
        {checkItems.length > 0 && <div><h4>Needs your review <span>{checkItems.length}</span></h4><div className="insights-card-list">{renderReportItems(checkItems)}</div></div>}
      </div> : <p className="insights-empty-list">{inbox ? (currentReport ? 'No suggestions for this analysis.' : 'No new findings. Analyze the canvas for more ideas.') : 'Loading recent findings…'}</p>}
      </section>}
      {currentReport && canvas && <ReportExplore report={currentReport} canvas={canvas} onOpenBlock={onOpenBlock} onStartPath={onStartPath}/>}
    </div>}
    {activeTool === 'groups' && <section id="jev-panel-groups" className="insights-tool-view" role="tabpanel" aria-label="Groups view">
      <div className="insights-tool-view__heading"><span>ORGANIZE</span><h3>Document groups</h3><p>See how the canvas is structured, then preview any placement changes.</p></div>
      <div className="insights-groups__routes">{onBrowseGroups && <button type="button" onClick={onBrowseGroups}>Browse saved groups</button>}{onAdvancedGrouping && <button type="button" onClick={onAdvancedGrouping}>Customize grouping</button>}</div>
      {canvas?.blocks.length ? <GroupDashboard canvas={canvas} report={currentReport} groupBy={groupBy} onGroupBy={setGroupBy} onOpenBlock={onOpenBlock}
        onPlace={() => void runAutomation('layout')} placing={applyingId === 'automation-layout'} disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)}/> : <p className="insights-empty-list">Add a document to begin grouping.</p>}
      {automationMessage && <p className="insights-automations__result" role="status">{automationMessage}</p>}
      {previewPanel}
    </section>}
    {activeTool === 'connections' && <section id="jev-panel-connections" className="insights-tool-view" role="tabpanel" aria-label="Connections view">
      <div className="insights-tool-view__heading"><span>RELATIONSHIPS</span><h3>Connections</h3><p>Check useful links, then choose exactly which changes to save.</p></div>
      {canvas && <p className="insights-tool-view__context">Current canvas: {canvas.blocks.length} documents, {canvas.blocks.reduce((count, block) => count + block.links.length, 0)} saved outgoing links. A run checks for useful links Jev can propose.</p>}
      <div className="insights-tool-view__actions"><button type="button" disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} onClick={() => void runAutomation('connection')}><Network size={16} aria-hidden="true"/> Preview connections</button>
        <button type="button" disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} onClick={() => void runAutomation('cross_connect')}><Network size={16} aria-hidden="true"/> Across canvases</button></div>
      {automationMessage && <p className="insights-automations__result" role="status">{automationMessage}</p>}
      {previewPanel}
    </section>}
    {activeTool === 'labels' && <section id="jev-panel-labels" className="insights-tool-view" role="tabpanel" aria-label="Labels view">
      <div className="insights-tool-view__heading"><span>CLASSIFY</span><h3>Labels & ownership</h3><p>Preview purpose, work area, or reviewer suggestions before saving.</p></div>
      {canvas && <p className="insights-tool-view__context">Saved labels on this canvas: {canvas.blocks.filter(block => block.purpose).length}/{canvas.blocks.length} purposes, {canvas.blocks.filter(block => block.workArea).length}/{canvas.blocks.length} work areas, {canvas.blocks.filter(block => block.reviewer).length}/{canvas.blocks.length} reviewers.</p>}
      <div className="insights-tool-view__actions"><button type="button" disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} onClick={() => void runAutomation('purpose')}><Tags size={16} aria-hidden="true"/> Purposes</button>
        <button type="button" disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} onClick={() => void runAutomation('work_area')}><Tags size={16} aria-hidden="true"/> Work areas</button>
        <button type="button" disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} onClick={() => void runAutomation('reviewer')}><UsersRound size={16} aria-hidden="true"/> Reviewers</button></div>
      {automationMessage && <p className="insights-automations__result" role="status">{automationMessage}</p>}
      {previewPanel}
    </section>}
    <section id="jev-panel-duplicates" className="insights-tool-view" role="tabpanel" aria-label="Duplicates view" hidden={activeTool !== 'duplicates'}>
      <div className="insights-tool-view__heading"><span>CLEAN UP</span><h3>Possible duplicates</h3><p>Compare overlapping documents and review a merge before applying it.</p></div>
      <DuplicateFinder canvas={canvas} hasApiKey={hasApiKey} dismissedIds={dismissedIds} onDismiss={item => void dismiss(item)} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} duplicateRequest={duplicateRequest} onActivityChange={setDuplicatePhase}/>
    </section>
    <section id="jev-panel-more" className="insights-tool-view" role="tabpanel" aria-label="More Jev tools view" hidden={activeTool !== 'more'}>
      <div className="insights-tool-view__heading"><span>WORKSPACE</span><h3>Workspace runs</h3><p>Review changes across canvases in one run. Canvas actions live in Groups, Connections, and Labels.</p></div>
      <WorkspaceAutomations canvas={canvas} hasApiKey={hasApiKey} onChanged={onChanged} onActivityChange={setWorkspacePhase}/>
    </section>
  </div>;
}
