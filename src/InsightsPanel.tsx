import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, LayoutGrid, Link2, LoaderCircle, Network, Search, Sparkles, Tags, UsersRound, WandSparkles } from 'lucide-react';
import type { CanvasDocument, GroupBy } from '../shared/types';
import { canvasGrouping, type AutomationKind, type InsightAction, type InsightCategory, type InsightItem, type InsightReport, type RankedBlock, type ReadingPath } from '../shared/insights';
import { groupByLabels, groupTone } from '../shared/groups';
import { api } from './api';
import './insights.css';

type InsightsPanelProps = {
  canvas: CanvasDocument | null;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onApply: (action: InsightAction) => Promise<void>;
  onOpenBlock: (blockId: string) => void;
  onMergeDraft?: (item: InsightItem, action: Extract<InsightAction, { type: 'merge' }>) => void;
  onDraftGap?: (item: InsightItem) => void;
  onStartPath?: (path: ReadingPath) => void;
  duplicateRequest?: { canvasId: string; blockId: string; sequence: number };
  /** Reload the canvas after a server-side automation changed it. */
  onChanged?: () => Promise<void> | void;
  groupBy?: GroupBy;
};

type AutomationResult = { kind: AutomationKind; applied: number; groupBy?: GroupBy; groups?: Array<{ key: string; count: number }> };
type WorkspaceKind = AutomationKind | 'dedupe' | 'tidy' | 'connect_all';
type WorkspaceChange = { id: string; canvasId: string; confidence: number; action: InsightAction; expectedContentHashes: Record<string, string>; requiresClick?: boolean };
type ChangeSet = { runId: string; workspaceId: string; kind: WorkspaceKind; dryRun: boolean; changes: WorkspaceChange[];
  groups: Array<{ canvasId: string; canvasName: string; count: number }>; applied?: string[]; skipped?: Array<{ id: string; reason: string }> };
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

const automationLabels: Record<Automation, string> = {
  layout: 'Organize positions', connection: 'Connect documents', regroup: 'Regroup & connect',
  purpose: 'Label purposes', work_area: 'Classify work areas', reviewer: 'Assign reviewers', cross_connect: 'Connect across canvases',
};

const automationNouns: Record<Automation, string> = {
  layout: 'layout update', connection: 'connection change', regroup: 'regroup change', purpose: 'purpose label', work_area: 'work-area label', reviewer: 'reviewer assignment', cross_connect: 'cross-canvas connection',
};

function percentage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function HealthTiles({ health }: { health: NonNullable<InsightReport['health']> }) {
  const tiles = [
    { label: 'Orphan docs', value: health.orphanRatio },
    { label: 'Duplicates', value: health.duplicateRatio },
    { label: 'Stale docs', value: health.staleRatio },
    { label: 'Mean quality', value: health.meanQuality },
    { label: 'Labels', value: health.labelCoverage },
  ];
  return <section aria-label="Canvas health" style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
    {tiles.map(tile => <div key={tile.label} style={{ flex: '1 1 78px', padding: '8px 9px', border: '1px solid #e4e9f3', borderRadius: 9, background: 'white' }}>
      <strong style={{ display: 'block', color: '#4058bd', fontSize: 13 }}>{tile.value === null ? '—' : percentage(tile.value)}</strong>
      <span style={{ color: '#8290a6', fontSize: 10 }}>{tile.label}</span>
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
  return <section className="insights-groups" aria-label="Document groups">
    <div className="insights-groups__top">
      <div className="insights-section__heading"><h3>Document groups</h3><p>{groups.length} {groups.length === 1 ? 'group' : 'groups'} · {canvas.blocks.length} docs{unsorted ? ` · ${unsorted} not classified yet` : ''}</p></div>
      <div className="insights-groups__tabs" role="tablist" aria-label="Group documents by">{(Object.keys(groupByLabels) as GroupBy[]).map(value =>
        <button key={value} type="button" role="tab" aria-selected={groupBy === value} onClick={() => onGroupBy(value)}>{groupByLabels[value]}</button>)}</div>
    </div>
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

function SuggestionCard({ item, canvas, applying, applied, dismissing, busy, onApply, onDismiss, onOpenBlock, onMergeDraft, onDraftGap, mergeUnavailableReason }: {
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
  mergeUnavailableReason?: string;
}) {
  const action = item.action;
  const canApply = action?.type === 'merge' ? undefined : action;
  return <article className={`insights-card insights-card--${item.category}`}>
    <div className="insights-card__meta"><span>{categoryLabels[item.category]}</span><span title="Confidence">{percentage(item.confidence)} confident</span></div>
    <h4>{item.title}</h4>
    <p>{item.detail}</p>
    {item.blockIds.length > 0 && <div className="insights-card__docs" aria-label="Affected documents">
      {item.blockIds.map(blockId => <AffectedDoc key={blockId} blockId={blockId} canvas={canvas} onOpenBlock={onOpenBlock}/>)}
    </div>}
    {item.evidence?.length ? <details className="insights-card__evidence" style={{ marginTop: 9, color: '#536683', fontSize: 10 }}><summary>Why?</summary>
      {item.evidence.map((entry, index) => <div key={`${entry.questionId}-${index}`}>
        <strong>{entry.questionId}</strong><p>Answer: {entry.answer}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.excerpt}</pre>
      </div>)}
    </details> : null}
    {canApply && <ApplyButton applying={applying} applied={applied} busy={busy} onClick={() => onApply(item.id, canApply)} label={canApply.type === 'move' ? 'Move document' : undefined}/>}
    {action?.type === 'merge' && onMergeDraft && <button type="button" className="insights-card__apply" disabled={busy || applied} onClick={() => onMergeDraft(item, action)}>Merge in chat</button>}
    {mergeUnavailableReason && <p style={{ fontSize: 11, color: '#795548' }}>{mergeUnavailableReason}</p>}
    {item.category === 'gap' && onDraftGap && <button type="button" className="insights-card__apply" disabled={busy || applied} onClick={() => onDraftGap(item)}>Draft it in chat</button>}
    <button type="button" className="insights-card__apply" style={{ marginLeft: canApply ? 12 : 0, color: '#73809a' }} disabled={busy || applied} onClick={() => onDismiss(item)}>{dismissing ? 'Dismissing…' : 'Dismiss'}</button>
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

function AnalysisForm({ canvasId, hasApiKey, loading, hasReport, query, onQuery, onAnalyze }: {
  canvasId: string;
  hasApiKey: boolean;
  loading: boolean;
  hasReport: boolean;
  query: string;
  onQuery: (value: string) => void;
  onAnalyze: () => void;
}) {
  const unavailable = !canvasId || !hasApiKey || loading;
  return <form className="insights-panel__form" onSubmit={event => { event.preventDefault(); onAnalyze(); }}>
    <label htmlFor="insights-query">Focus your analysis <span>Optional</span></label>
    <div className="insights-panel__query"><Search size={16} aria-hidden="true"/><input id="insights-query" value={query} onChange={event => onQuery(event.currentTarget.value)} placeholder="e.g. onboarding docs" disabled={unavailable}/></div>
    <button className="insights-panel__analyze" type="submit" disabled={unavailable}>{loading ? <LoaderCircle size={15} className="insights-spin" aria-hidden="true"/> : <Sparkles size={15} aria-hidden="true"/>}{analysisButtonText(loading, hasReport)}</button>
  </form>;
}

function AutomationButtons({ disabled, running, onRun }: {
  disabled: boolean;
  running: string;
  onRun: (automation: Automation) => void;
}) {
  const buttons = [
    { id: 'regroup', icon: WandSparkles }, { id: 'layout', icon: WandSparkles }, { id: 'connection', icon: Network },
    { id: 'cross_connect', icon: Network }, { id: 'purpose', icon: Tags }, { id: 'work_area', icon: Tags }, { id: 'reviewer', icon: UsersRound },
  ] as const;
  return <section className="insights-automations" aria-label="Canvas-wide automations">
    <div className="insights-automations__heading"><h3>Canvas-wide automations</h3><p>Analyze and apply changes, including adding or removing links.</p></div>
    <div className="insights-automations__grid">{buttons.map(({ id, icon: Icon }) => <button key={id} type="button" disabled={disabled} onClick={() => onRun(id)}>
      {running === `automation-${id}` ? <LoaderCircle size={15} className="insights-spin" aria-hidden="true"/> : <Icon size={15} aria-hidden="true"/>}
      <span>{automationLabels[id]}</span>
    </button>)}</div>
  </section>;
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

function WorkspaceAutomations({ canvas, hasApiKey, onChanged }: Pick<InsightsPanelProps, 'canvas' | 'hasApiKey' | 'onChanged'>) {
  const workspaceId = canvas?.workspaceId ?? '';
  const [kind, setKind] = useState<WorkspaceKind>('tidy');
  const [preview, setPreview] = useState<ChangeSet | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const [undone, setUndone] = useState(false);
  useEffect(() => { setPreview(null); setSelected(new Set()); setMessage(''); setError(''); setApplied(false); setUndone(false); }, [workspaceId]);

  async function previewChanges() {
    if (!workspaceId) return;
    setBusy('preview'); setError(''); setMessage(''); setPreview(null); setApplied(false); setUndone(false);
    try {
      const result = await api<ChangeSet>(`/workspaces/${encodeURIComponent(workspaceId)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind, dryRun: true }),
      });
      if (result.workspaceId !== workspaceId) throw new Error('The preview belongs to another workspace.');
      setPreview(result);
      setSelected(new Set(result.changes.filter(change => !change.requiresClick).map(change => change.id)));
      setMessage(`${result.changes.length} proposed change${result.changes.length === 1 ? '' : 's'} across ${result.groups.filter(group => group.count).length} canvas${result.groups.filter(group => group.count).length === 1 ? '' : 'es'}. No changes saved yet.`);
    } catch (failure) { setError(errorText(failure)); }
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
      setMessage(`Applied ${result.applied?.length ?? 0} change${result.applied?.length === 1 ? '' : 's'}${result.skipped?.length ? `; skipped ${result.skipped.length}.` : '.'}`);
      await onChanged?.();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(''); }
  }

  async function undo() {
    if (!preview || !applied || undone) return;
    setBusy('undo'); setError(''); setMessage('');
    try {
      const result = await api<{ reverted: string[]; skipped: Array<{ id: string; reason: string }> }>(`/jev-runs/${encodeURIComponent(preview.runId)}/undo`, { method: 'POST' });
      setUndone(true);
      setMessage(`Reverted ${result.reverted.length} change${result.reverted.length === 1 ? '' : 's'}${result.skipped.length ? `; skipped ${result.skipped.length}.` : '.'}`);
      await onChanged?.();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(''); }
  }

  function toggle(ids: string[], checked: boolean) {
    setSelected(current => { const next = new Set(current); ids.forEach(id => checked ? next.add(id) : next.delete(id)); return next; });
  }

  return <section className="insights-section" aria-label="Workspace automations">
    <div className="insights-section__heading"><h3>Across the workspace</h3><p>Preview changes on every canvas, then choose which to apply.</p></div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <label>Workspace action<select aria-label="Workspace action" value={kind} disabled={Boolean(busy)} onChange={event => { setKind(event.target.value as WorkspaceKind); setPreview(null); setMessage(''); setApplied(false); setUndone(false); }}>
        {workspaceKinds.map(option => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select></label>
      <button type="button" className="insights-card__apply" disabled={!workspaceId || !hasApiKey || Boolean(busy)} onClick={() => void previewChanges()}>{busy === 'preview' ? 'Previewing…' : 'Preview workspace changes'}</button>
    </div>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <div aria-label="Workspace change preview">
      {preview.groups.filter(group => group.count).map(group => {
        const changes = preview.changes.filter(change => change.canvasId === group.canvasId);
        const eligible = changes.filter(change => !change.requiresClick).map(change => change.id);
        return <section key={group.canvasId} aria-label={`${group.canvasName} changes`} style={{ border: '1px solid #e4e9f3', borderRadius: 8, padding: 10, marginTop: 9 }}>
          <label><input type="checkbox" aria-label={`Select all changes on ${group.canvasName}`} checked={eligible.length > 0 && eligible.every(id => selected.has(id))} disabled={applied || !eligible.length}
            onChange={event => toggle(eligible, event.currentTarget.checked)}/> <strong>{group.canvasName}</strong> · {changes.length} change{changes.length === 1 ? '' : 's'}</label>
          <div>{changes.map(change => <label key={change.id} style={{ display: 'block', marginTop: 7, paddingLeft: 12 }}>
            <input type="checkbox" aria-label={`Select ${actionDescription(change.action)}`} checked={selected.has(change.id)} disabled={applied || Boolean(change.requiresClick)}
              onChange={event => toggle([change.id], event.currentTarget.checked)}/> {actionDescription(change.action)} · {percentage(change.confidence)} confidence
            {change.requiresClick && <small> · Review in chat before merging</small>}
            {preview.skipped?.find(entry => entry.id === change.id) && <small> · Skipped: {preview.skipped.find(entry => entry.id === change.id)?.reason}</small>}
          </label>)}</div>
        </section>;
      })}
      <p>{selected.size} selected of {preview.changes.length} proposed changes</p>
      {!applied && <button type="button" className="insights-card__apply" disabled={!selected.size || Boolean(busy)} onClick={() => void applySelected()}>{busy === 'apply' ? 'Applying…' : `Apply selected (${selected.size})`}</button>}
      {applied && !undone && Boolean(preview.applied?.length) && <button type="button" className="insights-card__apply" disabled={Boolean(busy)} onClick={() => void undo()}>{busy === 'undo' ? 'Undoing…' : 'Undo this run'}</button>}
    </div>}
  </section>;
}

function DuplicateFinder({ canvas, hasApiKey, dismissedIds, onDismiss, onOpenBlock, onMergeDraft, duplicateRequest }: Pick<InsightsPanelProps, 'canvas' | 'hasApiKey' | 'onOpenBlock' | 'onMergeDraft' | 'duplicateRequest'> & {
  dismissedIds: Set<string>; onDismiss: (item: InsightItem) => void;
}) {
  const canvasId = canvas?.id ?? '';
  const [crossCanvas, setCrossCanvas] = useState(false);
  const [blockId, setBlockId] = useState('');
  const [items, setItems] = useState<DuplicateCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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

function ReportResults({ report, canvas, applyingId, appliedIds, dismissedIds, onApply, onDismiss, onOpenBlock, onMergeDraft, onDraftGap, onStartPath }: {
  report: InsightReport;
  canvas: CanvasDocument;
  applyingId: string;
  appliedIds: Set<string>;
  dismissedIds: Set<string>;
  onApply: (id: string, action: InsightAction) => void;
  onDismiss: (item: InsightItem) => void;
  onOpenBlock: (blockId: string) => void;
  onMergeDraft?: InsightsPanelProps['onMergeDraft'];
  onDraftGap?: InsightsPanelProps['onDraftGap'];
  onStartPath?: InsightsPanelProps['onStartPath'];
}) {
  const items = report.items.filter(item => !dismissedIds.has(item.id));
  return <div className="insights-panel__results" aria-live="polite">
    <div className="insights-panel__summary"><strong>{report.analyzed} of {report.total} docs analyzed</strong>{report.query && <span>Focus: {report.query}</span>}</div>
    {report.notice && <p className="insights-panel__notice">{report.notice}</p>}
    {report.health && <HealthTiles health={report.health}/>}
    {Boolean(report.readingPaths?.length) && <section className="insights-section" aria-label="Reading paths">
      <div className="insights-section__heading"><h3>Reading paths</h3><p>Follow a focused sequence of documents.</p></div>
      <div className="insights-card-list">{report.readingPaths?.map(path => <article className="insights-card" key={path.id}>
        <h4>{path.name}</h4><p>{path.blockIds.length} documents</p>
        <button type="button" className="insights-card__apply" disabled={!onStartPath || !path.blockIds.some(id => canvas.blocks.some(block => block.id === id))} onClick={() => onStartPath?.(path)}>Start path</button>
      </article>)}</div>
    </section>}
    <RankedList title="Suggested reading order" description="A path through these documents" items={report.readingOrder} onOpenBlock={onOpenBlock}/>
    <RankedList title="Most relevant" description={report.query ? `Best matches for “${report.query}”` : 'Documents with the strongest signal'} items={report.relevance} onOpenBlock={onOpenBlock}/>
    <section className="insights-section" aria-label="Suggestions"><div className="insights-section__heading"><h3>Suggestions <span>{items.length}</span></h3><p>Review each idea before applying it.</p></div>
      {items.length === 0 ? <p className="insights-empty-list">No suggestions for this analysis.</p> : <div className="insights-card-list">{items.map(item => <SuggestionCard key={item.id} item={item} canvas={canvas} applying={applyingId === item.id} applied={appliedIds.has(item.id)} dismissing={applyingId === `dismiss-${item.id}`} busy={Boolean(applyingId)} onApply={onApply} onDismiss={onDismiss} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} onDraftGap={onDraftGap}/>)}</div>}
    </section>
  </div>;
}

function ReportContent({ canvas, report, loading, applyingId, appliedIds, dismissedIds, onApply, onDismiss, onOpenBlock, onMergeDraft, onDraftGap, onStartPath }: {
  canvas: CanvasDocument | null;
  report: InsightReport | null;
  loading: boolean;
  applyingId: string;
  appliedIds: Set<string>;
  dismissedIds: Set<string>;
  onApply: (id: string, action: InsightAction) => void;
  onDismiss: (item: InsightItem) => void;
  onOpenBlock: (blockId: string) => void;
  onMergeDraft?: InsightsPanelProps['onMergeDraft'];
  onDraftGap?: InsightsPanelProps['onDraftGap'];
  onStartPath?: InsightsPanelProps['onStartPath'];
}) {
  if (!canvas) return <div className="insights-panel__empty"><FileText size={24} aria-hidden="true"/><p>Open a canvas to see its insights.</p></div>;
  if (report) return <ReportResults report={report} canvas={canvas} applyingId={applyingId} appliedIds={appliedIds} dismissedIds={dismissedIds} onApply={onApply} onDismiss={onDismiss} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} onDraftGap={onDraftGap} onStartPath={onStartPath}/>;
  if (loading) return null;
  return <div className="insights-panel__empty"><Link2 size={24} aria-hidden="true"/><p>Analyze this canvas to discover a reading path, relevant docs, and suggested improvements.</p></div>;
}

function automationUnavailable(canvas: CanvasDocument | null, hasApiKey: boolean, loading: boolean, applyingId: string) {
  return !canvas?.id || !hasApiKey || !canvas.blocks.length || loading || Boolean(applyingId);
}

export function InsightsPanel({ canvas, hasApiKey, onOpenSettings, onApply, onOpenBlock, onMergeDraft, onDraftGap, onStartPath, duplicateRequest, onChanged, groupBy: initialGroupBy = 'work_area' }: InsightsPanelProps) {
  const canvasId = canvas?.id ?? '';
  const [groupBy, setGroupBy] = useState<GroupBy>(initialGroupBy);
  useEffect(() => setGroupBy(initialGroupBy), [initialGroupBy]);
  const [query, setQuery] = useState('');
  const [report, setReport] = useState<InsightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [applyingId, setApplyingId] = useState('');
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [errorAction, setErrorAction] = useState(false);
  const [automationMessage, setAutomationMessage] = useState('');
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const latestCanvasId = useRef(canvasId);
  latestCanvasId.current = canvasId;

  useEffect(() => {
    setReport(null);
    setError('');
    setErrorAction(false);
    setLoading(false);
    setApplyingId('');
    setAppliedIds(new Set());
    setDismissedIds(new Set());
    setAutomationMessage('');
    return () => {
      requestVersion.current++;
      activeRequest.current?.abort();
    };
  }, [canvasId]);

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

  async function analyze(): Promise<InsightReport | null> {
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
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      if (isCurrentAnalysis(version, result.canvasId)) {
        setReport(result);
        return result;
      }
    } catch (failure) {
      handleAnalysisError(version, controller, failure);
    } finally {
      finishAnalysis(version);
    }
    return null;
  }

  function resultMessage(kind: Automation, result: AutomationResult): string {
    if (!result.applied) return `No eligible ${automationNouns[kind]}s found for this canvas.`;
    if (result.groups?.length) {
      const docs = result.groups.reduce((sum, group) => sum + group.count, 0);
      return `Placed ${docs} documents in ${result.groups.length} ${result.groups.length === 1 ? 'group' : 'groups'}${kind === 'regroup' ? ' and updated links' : ''}.`;
    }
    return `Applied ${result.applied} ${automationNouns[kind]}${result.applied === 1 ? '' : 's'} across this canvas.`;
  }

  /** One request: the server asks Jev only what this automation needs and saves the changes. */
  async function runAutomation(automation: Automation): Promise<void> {
    const target = canvasId;
    setApplyingId(`automation-${automation}`);
    setAutomationMessage('');
    setError('');
    try {
      const grouped = automation === 'layout' || automation === 'regroup';
      const result = await api<AutomationResult>(`/canvases/${encodeURIComponent(target)}/automations`, {
        method: 'POST', body: JSON.stringify({ kind: automation, ...(grouped ? { groupBy } : {}) }),
      });
      if (latestCanvasId.current !== target) return;
      if (result.applied) setReport(null);
      await onChanged?.();
      if (latestCanvasId.current === target) setAutomationMessage(resultMessage(automation, result));
    } catch (failure) {
      if (latestCanvasId.current === target) {
        setError(`Automation stopped. Earlier changes may have saved. ${errorText(failure)}`);
        setErrorAction(true);
      }
    } finally {
      if (latestCanvasId.current === target) setApplyingId('');
    }
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
        setError(errorText(failure));
        setErrorAction(true);
      }
    } finally {
      if (latestCanvasId.current === target) setApplyingId('');
    }
  }

  const currentReport = report?.canvasId === canvasId ? report : null;

  return <div className="insights-panel">
    <div className="insights-panel__intro"><div className="insights-panel__icon"><Sparkles size={20} aria-hidden="true"/></div><div><h2>Canvas insights</h2><p>Explore your docs, then choose which changes to apply.</p></div></div>
    <SetupBanner hasApiKey={hasApiKey} onOpenSettings={onOpenSettings}/>
    <AnalysisForm canvasId={canvasId} hasApiKey={hasApiKey} loading={loading || Boolean(applyingId)} hasReport={Boolean(currentReport)} query={query} onQuery={setQuery} onAnalyze={() => void analyze()}/>
    <AutomationButtons disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)} running={applyingId} onRun={automation => void runAutomation(automation)}/>
    <WorkspaceAutomations canvas={canvas} hasApiKey={hasApiKey} onChanged={onChanged}/>
    <DuplicateFinder canvas={canvas} hasApiKey={hasApiKey} dismissedIds={dismissedIds} onDismiss={item => void dismiss(item)} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} duplicateRequest={duplicateRequest}/>
    {automationMessage && <p className="insights-automations__result" role="status">{automationMessage}</p>}
    <ErrorBanner error={error} errorAction={errorAction} onRetry={() => void analyze()}/>
    {canvas && canvas.blocks.length > 0 && <GroupDashboard canvas={canvas} report={currentReport} groupBy={groupBy} onGroupBy={setGroupBy} onOpenBlock={onOpenBlock}
      onPlace={() => void runAutomation('layout')} placing={applyingId === 'automation-layout'} disabled={automationUnavailable(canvas, hasApiKey, loading, applyingId)}/>}
    <ReportContent canvas={canvas} report={currentReport} loading={loading} applyingId={applyingId} appliedIds={appliedIds} dismissedIds={dismissedIds}
      onApply={(id, action) => void apply(id, action)} onDismiss={item => void dismiss(item)} onOpenBlock={onOpenBlock} onMergeDraft={onMergeDraft} onDraftGap={onDraftGap} onStartPath={onStartPath}/>
  </div>;
}
