import { useEffect, useState, type ReactNode } from 'react';
import { jevActions, type JevJob, type JevPassage, type JevProposal, type JevReceipt, type JevValues } from '../shared/jev-types';
import { jevActionLabels } from '../shared/jev-action-labels';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { JevSettings } from './JevSettings';
import { JevThresholds } from './JevThresholds';
import { JevReset } from './JevReset';
import { JevFacts, JevMutationSummary } from './JevFacts';
import { JevDocumentProgress } from './JevDocumentProgress';
import { groupDisplayPath } from './canvas-group-labels';
import type { JevEvidenceNavigation, JevViewState } from './jev-client-types';
import type { JevWorkspaceModel } from './useJevWorkspace';
import './ai-chat.css';
import './jev.css';

type PanelProps = { canvas: CanvasDocument | null; model: JevWorkspaceModel; settingsRequest: number; onAddSource: () => void;
  onOpenDocument: (canvasId: string, id: string) => void; onOpenEvidence: JevEvidenceNavigation; onShowCanvas: (canvasId: string, blockId: string) => void };
type CanvasProps = Omit<PanelProps, 'canvas'> & { canvas: CanvasDocument };
const automaticActions = new Set<string>(jevActions);

export function JevPanel(props: PanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { if (props.settingsRequest) setSettingsOpen(true); }, [props.settingsRequest]);
  if (!props.canvas) return <p>Select a canvas to open workspace organization.</p>;
  return <section className="ai-chat jev-panel" aria-label="Symbi Reflex organization">
    <div className="jev-utilities"><small>Automatic organization</small>
      {settingsOpen && <button type="button" onClick={() => setSettingsOpen(false)}>Back to thresholds</button>}
    </div>
    <div className="jev-panel__body"><WorkspaceNotice model={props.model}/>
      {settingsOpen ? <JevSettings model={props.model} canvasId={props.canvas.id}/> : <><JevThresholds model={props.model}/><JevReset model={props.model}/><AutomaticContents {...props} canvas={props.canvas}/></>}
    </div>
  </section>;
}

function WorkspaceNotice({ model }: { model: JevWorkspaceModel }) {
  return <>{model.error && <div className="ai-chat__error" role="alert">{model.error} <button type="button" onClick={() => void model.refresh()}>Retry</button></div>}
    {model.notice && <p className="jev-notice" role="status">{model.notice}</p>}{!model.state && !model.error && <p role="status">Opening workspace organization…</p>}</>;
}

function AutomaticContents(props: CanvasProps) {
  useEffect(() => () => props.model.setDetailsOpen(false), [props.model.setDetailsOpen]);
  const state = props.model.state;
  if (!state) return null;
  const jobs = state.jobs.filter(job => job.request.canvasId === props.canvas.id && automaticActions.has(job.request.action));
  return <><AutomaticStatus state={state} canvas={props.canvas} jobs={jobs}/>
    <JevDocumentProgress canvas={props.canvas} documents={props.model.progress ?? []} error={props.model.progressError}/>
    <LazyDetails className="jev-results" title="Automatic findings and saved results" onOpenChange={props.model.setDetailsOpen}>
      {() => state.summary ? <p role="status">Loading saved findings…</p> : <SavedContents {...props} state={state} jobs={jobs}/>}
    </LazyDetails>
  </>;
}

function SavedContents(props: CanvasProps & { state: JevViewState; jobs: JevJob[] }) {
  const { state } = props;
  const jobs = state.jobs.filter(job => job.request.canvasId === props.canvas.id);
  const findings = state.proposals.filter(proposal => (automaticActions.has(proposal.action) || proposal.state === 'applied')
    && ['pending', 'applied'].includes(proposal.state) && proposal.sources.some(source => source.canvasId === props.canvas.id));
  const receipts = state.receipts.filter(receipt => receipt.state === 'applied'
    && receipt.sourcesAfter.some(source => source.canvasId === props.canvas.id));
  return <>
      <AutomaticFindings findings={findings} onOpenEvidence={props.onOpenEvidence}/>
      <SavedActivity jobs={jobs} receipts={receipts} onShowCanvas={props.onShowCanvas}/>
      <DocumentProfiles state={state} canvas={props.canvas} onOpenDocument={props.onOpenDocument}/>
    </>;
}

function unavailableReason(state: JevViewState): string {
  if (!state.hasApiKey) return 'Waiting for a TypeSafe API key in Settings.';
  if (!state.settings.externalProcessing) return 'Automatic processing is unavailable in this workspace.';
  if (state.settings.paused) return 'Automatic processing is paused.';
  return '';
}

function AutomaticStatus({ state, canvas, jobs }: { state: JevViewState; canvas: CanvasDocument; jobs: JevJob[] }) {
  const unavailable = unavailableReason(state);
  const working = jobs.filter(job => ['queued', 'running'].includes(job.state));
  return <section aria-label="Automatic organization status" className="jev-card"><h2>Jev works automatically</h2>
    <p>All {jevActions.length} actions run on saved documents and update their results automatically.</p>
    <p role="status">{unavailable || (working.length ? `${working.length} automatic checks in progress` : 'Watching saved documents for changes.')}</p>
    <DocumentUnderstanding state={state} canvas={canvas}/>
    {!unavailable && !working.length && <OrganizationOutcomes canvas={canvas} jobs={jobs}/>}
    {!canvas.blocks.length && <p>New saved documents will be organized automatically.</p>}
  </section>;
}

function hasUnderstanding(profile?: JevValues): boolean {
  if (!profile) return false;
  if (Array.isArray(profile.keyPassages) && profile.keyPassages.length) return true;
  return typeof profile.role === 'string' && !['unknown', 'none'].includes(profile.role);
}

function DocumentUnderstanding({ state, canvas }: { state: JevViewState; canvas: CanvasDocument }) {
  if (!canvas.blocks.length) return null;
  const understood = canvas.blocks.filter(block => hasUnderstanding(state.profiles[`${canvas.id}:${block.id}`])).length;
  return <p>Document understanding: {understood} of {canvas.blocks.length} documents have a supported role or key passage.</p>;
}

const outcomeMessages: Record<string, string> = {
  'file:insufficient_group_evidence': 'No groups saved yet: the latest check could not verify a suitable group from the document passages.',
  'file:insufficient_local_group_purpose': 'No groups saved yet: the latest check could not verify a shared document purpose.',
  'file:no_source_derived_group_names': 'No groups saved yet: the latest check could not find a reusable topic in the document passages.',
  'file:no_change': 'Grouping checked: no supported change was needed.',
  'label:missing_label_vocabulary': 'No labels saved yet: the latest check had no reusable label vocabulary.',
};

function OrganizationOutcomes({ canvas, jobs }: { canvas: CanvasDocument; jobs: JevJob[] }) {
  const latest = new Map([...jobs].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).map(job => [job.request.action, job]));
  return <>{!canvas.blocks.some(block => block.group) && <ActionOutcome job={latest.get('file')}/>}
    {!canvas.blocks.some(block => block.tags?.length) && <ActionOutcome job={latest.get('label')}/>}</>;
}

function ActionOutcome({ job }: { job?: JevJob }) {
  if (!job || job.state !== 'completed') return null;
  const message = outcomeMessages[`${job.request.action}:${job.result?.status}`];
  return message ? <p>{message}</p> : null;
}

function AutomaticFindings({ findings, onOpenEvidence }: { findings: JevProposal[]; onOpenEvidence: JevEvidenceNavigation }) {
  return <section aria-label="Automatic findings"><h2>Findings</h2>
    {findings.length ? findings.slice(-12).reverse().map(proposal => <Finding key={proposal.id} proposal={proposal} onOpenEvidence={onOpenEvidence}/>)
      : <p>Document understanding, grouping, labels, connections, duplicate comparisons, and canvas suggestions appear here as checks finish.</p>}
  </section>;
}

function Finding({ proposal, onOpenEvidence }: { proposal: JevProposal; onOpenEvidence: JevEvidenceNavigation }) {
  return <article className="jev-card" data-proposal-id={proposal.id}><small>{jevActionLabels[proposal.action]} · {proposal.state === 'applied' ? 'Saved automatically' : 'Not saved'}</small>
    <strong>{proposal.title}</strong><p>{proposal.explanation}</p>
    {proposal.automaticHoldReason && <p>{proposal.automaticHoldReason}</p>}
    <LazyDetails title="Finding details and source evidence">{() => <><JevMutationSummary mutation={proposal.mutation}/>
      <SourceEvidence evidence={proposal.evidence} onOpenEvidence={onOpenEvidence}/></>}</LazyDetails>
  </article>;
}

function SourceEvidence({ evidence, onOpenEvidence }: { evidence: JevPassage[]; onOpenEvidence: JevEvidenceNavigation }) {
  return <>{evidence.map((passage, index) => <blockquote key={index}>{passage.quote}
    <button type="button" onClick={() => onOpenEvidence(passage)}>Open source passage</button></blockquote>)}</>;
}

function SavedActivity({ jobs, receipts, onShowCanvas }: { jobs: JevJob[]; receipts: JevReceipt[]; onShowCanvas: PanelProps['onShowCanvas'] }) {
  if (!jobs.length && !receipts.length) return null;
  return <LazyDetails className="jev-activity" title={`Saved activity · ${receipts.length} results`}>{() => <>
    {receipts.slice(-8).reverse().map(receipt => <SavedResult key={receipt.id} receipt={receipt} onShowCanvas={onShowCanvas}/>)}
    {jobs.slice(-8).reverse().map(job => <article className="jev-card" key={job.id}><strong>{jevActionLabels[job.request.action]} · {job.state}</strong>
      {job.error && <p role="alert">{job.error}</p>}<p>{job.proposalIds.length} findings</p></article>)}
  </>}</LazyDetails>;
}

function SavedResult({ receipt, onShowCanvas }: { receipt: JevReceipt; onShowCanvas: PanelProps['onShowCanvas'] }) {
  const source = receipt.sourcesAfter[0];
  return <article className="jev-card" data-receipt-id={receipt.id}><strong>{jevActionLabels[receipt.action]} · saved</strong>
    <LazyDetails title="View saved result">{() => <JevMutationSummary mutation={receipt.after}/>}</LazyDetails>
    {source && <button type="button" onClick={() => onShowCanvas(source.canvasId, source.blockId)}>Show on canvas</button>}
  </article>;
}

function DocumentProfiles({ state, canvas, onOpenDocument }: { state: JevViewState; canvas: CanvasDocument; onOpenDocument: PanelProps['onOpenDocument'] }) {
  if (!canvas.blocks.length) return null;
  return <LazyDetails className="jev-tools" title="Document profiles and connections">
    {() => canvas.blocks.map(block => <LazyDetails className="jev-card" key={block.id} title={block.title}>{() => <>
      <p>Group: {block.group ? groupDisplayPath(block.group, canvas.groupLabels) : 'Ungrouped'} · Labels: {(block.tags ?? []).join(', ') || 'None'}</p>
      {block.reviewer && <p>Reviewer: {block.reviewer}</p>}{block.quality && <p>Quality: {block.quality.score}</p>}
      <ProfileFacts values={state.profiles[`${canvas.id}:${block.id}`]}/>
      <button type="button" onClick={() => onOpenDocument(canvas.id, block.id)}>Read document</button>
      <DocumentConnections block={block} canvas={canvas} onOpenDocument={onOpenDocument}/>
    </>}</LazyDetails>)}
  </LazyDetails>;
}

function LazyDetails({ className, title, children, onOpenChange }: { className?: string; title: string; children: () => ReactNode; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={event => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open);
  }}>
    <summary>{title}</summary>{open && children()}
  </details>;
}

function ProfileFacts({ values }: { values?: JevValues }) {
  const visible = Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => ['role', 'roleConfidence', 'addressesAi', 'addressesAiConfidence', 'keyPassages', 'entities', 'qualityRubric', 'recall'].includes(key)));
  return Object.keys(visible).length ? <JevFacts values={visible}/> : <p>Document understanding will appear after the automatic check.</p>;
}

function DocumentConnections({ block, canvas, onOpenDocument }: { block: CanvasBlock; canvas: CanvasDocument; onOpenDocument: PanelProps['onOpenDocument'] }) {
  return <LazyDetails title={`Saved connections · ${block.links.length + (block.crossLinks?.length ?? 0)}`}>{() => <>
    {block.links.map(id => <p key={id}>{block.linkTypes?.[id] ?? 'related'}: <button type="button" onClick={() => onOpenDocument(canvas.id, id)}>
      {canvas.blocks.find(item => item.id === id)?.title ?? 'Unavailable document'}</button></p>)}
    {block.crossLinks?.map(link => <p key={`${link.canvasId}:${link.blockId}`}>{link.relation ?? 'related'}: <button type="button"
      onClick={() => onOpenDocument(link.canvasId, link.blockId)}>{link.blockId}</button></p>)}
  </>}</LazyDetails>;
}
