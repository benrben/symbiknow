import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Circle, Copy, LoaderCircle, ShieldCheck, Square, Wrench } from 'lucide-react';
import { Conversation, ConversationContent, ConversationScrollButton } from './components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from './components/ai-elements/prompt-input';
import { streamCanvasChat, type AgentStep, type ChatProposal, type ChatProposalReceipt, type ChatProposalUndoReceipt, type ChatTurn, type Verification } from './chatStream';
import { chatHistoryKey } from './chat-history';
import { SavedInvestigations, type InvestigationRecord, type InvestigationProposalRef, type InvestigationResearchSnapshot, type InvestigationSourceRef } from './SavedInvestigations';
import { api } from './api';
import type { AnswerCanvasResult, AnswerCanvasTurn, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch, ResearchLayout, ResearchSurfaceChoice } from '../shared/answer-canvas';
import type { ResearchCanvasEdits } from './research-edits';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { chatSuggestions } from './chat-suggestions';
import { chatScopeOptions, requestContextForScope, type ChatScope } from './chat-context';
import { SymbiAvatar, type SymbiState } from './SymbiAvatar';
import type { CanvasChanges, CanvasEdit } from './canvas-changes';
import './ai-chat.css';

type AIElementsChatProps = {
  canvasId: string;
  canvas: CanvasDocument | null;
  viewContext: ChatViewContext;
  answerTurns: AnswerCanvasTurn[];
  researchEdits?: ResearchCanvasEdits;
  researchLayout?: ResearchLayout;
  hasApiKey: boolean;
  jevAvailable?: boolean;
  model: string;
  promptRequest?: { text: string; sequence: number; mergeDraft?: MergeDraftRequest };
  focusRequest?: number;
  investigationOpenRequest?: { id: string; sequence: number };
  onActiveInvestigationChange?: (reference?: { id: string; canvasId: string }) => void;
  onMergeDraft?: (markdown: string, request: MergeDraftRequest) => void;
  onOpenSettings: () => void;
  onCanvasChanged: (canvasId: string, beforeBlocks: CanvasBlock[]) => Promise<CanvasChanges>;
  onShowBlock: (block: CanvasBlock, canvasId?: string) => void;
  onNavigate: (target: CanvasNavigationTarget) => void;
  onReturnNavigation: () => void;
  onUndoCreatedBlock: (canvasId: string, block: CanvasBlock) => Promise<void>;
  onUndoEditedBlock: (canvasId: string, edit: CanvasEdit) => Promise<void>;
  onCanvasSources: (id: number, result: AnswerCanvasResult) => void;
  onCanvasPatch: (id: number, patch: ResearchCanvasPatch) => void;
  onCanvasAnswer: (id: number, answer: string) => void;
  onCanvasTurnEnd: (id: number, status: 'complete' | 'stopped') => void;
  onRestoreResearch?: (snapshot?: InvestigationResearchSnapshot) => void;
  onOpenAnswerCanvas: () => void;
  onAvatarStateChange?: (state: SymbiState) => void;
  onHistoryChange?: (hasHistory: boolean) => void;
};

export type MergeDraftRequest = { keepBlockId: string; mergeBlockIds: string[]; intentToken?: string };

type Activity = { key: number; type: 'thinking' | 'tool'; id?: string; name?: string; message: string; status: 'active' | 'complete' | 'stopped' };
type DisplayTurn = ChatTurn & { id: number; activities: Activity[]; verification?: Verification; createdBlocks?: CanvasBlock[]; editedBlocks?: CanvasEdit[];
  createdCanvasId?: string; undoMessage?: string; undoError?: string;
  proposal?: ChatProposal; selectedProposalIds?: string[]; proposalState?: 'pending' | 'applying' | 'applied' | 'reverted' | 'expired' | 'failed';
  proposalReceipt?: ChatProposalReceipt; proposalUndoReceipt?: ChatProposalUndoReceipt; proposalError?: string;
  mergeDraft?: MergeDraftRequest; answerCanvas?: AnswerCanvasResult; researchPatch?: ResearchCanvasPatch;
  presentationChoice?: ResearchSurfaceChoice; navigation?: CanvasNavigationTarget };
type ChatStatus = 'ready' | 'submitted' | 'streaming';

function restoredTurns(): DisplayTurn[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(chatHistoryKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((turn): turn is DisplayTurn => turn && typeof turn === 'object'
      && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string'
      && Number.isInteger(turn.id) && Array.isArray(turn.activities)).slice(-60)
      .map(turn => ({ ...turn, activities: finishActivity(turn.activities, 'stopped') }));
  } catch { return []; }
}

const jevAnalysisTools = new Set(['analyze_canvas', 'find_duplicates', 'connect_across_canvases', 'score_documents']);
const jevActionTools = new Set(['merge_documents', 'organize_canvas', 'regroup_canvas', 'connect_documents',
  'label_purposes', 'classify_work_areas', 'assign_reviewers']);
const searchTools = new Set(['search_docs', 'search_canvas']);
const readingTools = new Set(['read_doc', 'read_block', 'read_file', 'list_tasks']);
const navigationTools = new Set(['show_doc_on_canvas', 'show_group_on_canvas']);
const workingTools = new Set(['draw_research_canvas', 'create_doc', 'edit_doc', 'move_block', 'link_blocks', 'delete_doc',
  'create_task', 'update_task']);

function activeToolState(turn?: DisplayTurn): SymbiState | null {
  const tool = [...(turn?.activities ?? [])].reverse().find(activity => activity.type === 'tool' && activity.status === 'active');
  if (!tool) return null;
  if (jevActionTools.has(tool?.name ?? '')) return 'jev-applying';
  if (jevAnalysisTools.has(tool?.name ?? '')) return 'jev-analyzing';
  if (searchTools.has(tool.name ?? '')) return 'searching';
  if (readingTools.has(tool.name ?? '')) return 'reading';
  if (navigationTools.has(tool.name ?? '')) return 'navigating';
  if (workingTools.has(tool.name ?? '')) return 'working';
  return 'tooling';
}

function activityStatus(state: SymbiState): string | null {
  if (state === 'searching') return 'Searching documents…';
  if (state === 'reading') return 'Reading the source…';
  if (state === 'working') return 'Updating the canvas…';
  if (state === 'navigating') return 'Opening the right place…';
  if (state === 'tooling') return 'Working with a tool…';
  if (state === 'jev-routing') return 'Jev is choosing the right context…';
  if (state === 'jev-analyzing') return 'Jev is analyzing this canvas…';
  if (state === 'jev-verifying') return 'Jev is checking the answer…';
  if (state === 'jev-applying') return 'Jev is applying the change…';
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function editPreview(edit: CanvasEdit): { fields: string; before: string; after: string } {
  const changed = (['title', 'content', 'kind', 'group', 'links', 'x', 'y', 'tags'] as const)
    .filter(field => JSON.stringify(edit.before[field]) !== JSON.stringify(edit.after[field]));
  const before = edit.before.content;
  const after = edit.after.content;
  let firstChange = 0;
  while (firstChange < Math.min(before.length, after.length) && before[firstChange] === after[firstChange]) firstChange++;
  const start = Math.max(0, firstChange - 60);
  const short = (value: string) => {
    const end = Math.min(value.length, start + 240);
    return `${start ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
  };
  return { fields: changed.length ? changed.join(', ') : 'document details',
    before: short(before), after: short(after) };
}

function markdownDraft(answer: string): string | undefined {
  const normalized = answer.replace(/\r\n?/g, '\n');
  const fenced = normalized.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*(?=\n|$)/iu);
  return fenced?.[2];
}

function discardIntentToken(turns: DisplayTurn[], id: number): DisplayTurn[] {
  return turns.map(turn => turn.id === id && turn.mergeDraft
    ? { ...turn, mergeDraft: { keepBlockId: turn.mergeDraft.keepBlockId, mergeBlockIds: turn.mergeDraft.mergeBlockIds } }
    : turn);
}

function updatedAssistant(turns: DisplayTurn[], id: number, content: string): DisplayTurn[] {
  return turns.map(turn => turn.id === id ? { ...turn, content: turn.content + content, activities: finishThinking(turn.activities) } : turn);
}

function finishThinking(activities: Activity[]): Activity[] {
  return activities.map(activity => activity.type === 'thinking' && activity.status === 'active' ? { ...activity, status: 'complete' } : activity);
}

function finishActivity(activities: Activity[], outcome: 'complete' | 'stopped'): Activity[] {
  return activities.map(activity => activity.status === 'active' ? { ...activity, status: outcome === 'complete' && activity.type === 'thinking' ? 'complete' : 'stopped' } : activity);
}

function toolById(activities: Activity[], id: string): number {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity.type === 'tool' && activity.id === id) return index;
  }
  return -1;
}

function adjacentTool(activities: Activity[], name: string): number {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity.type === 'thinking') continue;
    return activity.name === name ? index : -1;
  }
  return -1;
}

function repeatedStart(activities: Activity[], step: AgentStep): boolean {
  if (step.id) return toolById(activities, step.id) >= 0;
  return Boolean(step.name && adjacentTool(activities, step.name) >= 0);
}

function toolEndIndex(activities: Activity[], step: AgentStep): number {
  if (step.id) return toolById(activities, step.id);
  if (step.name) return adjacentTool(activities, step.name);
  return -1;
}

function addThinking(activities: Activity[], step: AgentStep, key: number): Activity[] {
  const latest = activities.at(-1);
  if (latest?.type === 'thinking' && latest.message === step.message) return activities;
  return [...finishThinking(activities), { key, type: 'thinking', message: step.message, status: 'active' }];
}

function addToolStart(activities: Activity[], step: AgentStep, key: number): Activity[] {
  if (repeatedStart(activities, step)) return activities;
  return [...finishThinking(activities), { key, type: 'tool', id: step.id, name: step.name, message: step.message, status: 'active' }];
}

function addToolEnd(activities: Activity[], step: AgentStep, key: number): Activity[] {
  const match = toolEndIndex(activities, step);
  if (match >= 0) {
    const matched = activities[match];
    if (matched.status === 'complete' && matched.message === step.message) return activities;
    return finishThinking(activities).map((activity, index) => index === match ? { ...activity, message: step.message, status: 'complete' } : activity);
  }
  return [...finishThinking(activities), { key, type: 'tool', id: step.id, name: step.name, message: step.message, status: 'complete' }];
}

function addActivity(activities: Activity[], step: AgentStep, key: number): Activity[] {
  if (step.type === 'thinking') return addThinking(activities, step, key);
  if (step.type === 'tool_start') return addToolStart(activities, step, key);
  return addToolEnd(activities, step, key);
}

function updatedActivity(turns: DisplayTurn[], id: number, step: AgentStep, key: number): DisplayTurn[] {
  let changed = false;
  const next = turns.map(turn => {
    if (turn.id !== id) return turn;
    const activities = addActivity(turn.activities, step, key);
    if (activities === turn.activities) return turn;
    changed = true;
    return { ...turn, activities };
  });
  return changed ? next : turns;
}

/** Text streamed before a tool call was a working note; keep it in the activity list instead of the answer. */
function resetAssistant(turns: DisplayTurn[], id: number, key: number): DisplayTurn[] {
  return turns.map(turn => {
    if (turn.id !== id || !turn.content.trim()) return turn.id === id ? { ...turn, content: '' } : turn;
    const note = turn.content.trim().replace(/\s+/g, ' ');
    return { ...turn, content: '', activities: [...finishThinking(turn.activities),
      { key, type: 'thinking' as const, message: note.length > 220 ? `${note.slice(0, 217)}…` : note, status: 'complete' as const }] };
  });
}

function verifiedAssistant(turns: DisplayTurn[], id: number, verification: Verification): DisplayTurn[] {
  return turns.map(turn => turn.id === id ? { ...turn, verification } : turn);
}

function settledAssistant(turns: DisplayTurn[], id: number, outcome: 'complete' | 'stopped'): DisplayTurn[] {
  return turns.map(turn => turn.id === id ? { ...turn, activities: finishActivity(turn.activities, outcome) } : turn);
}

function ActivityIcon({ activity }: { activity: Activity }) {
  if (activity.status === 'active') return <LoaderCircle size={14} className="ai-chat__activity-spin" aria-hidden="true"/>;
  if (activity.status === 'stopped') return <Square size={12} aria-hidden="true"/>;
  return activity.type === 'tool' ? <Wrench size={13} aria-hidden="true"/> : <Check size={13} aria-hidden="true"/>;
}

function activitySummary(activities: Activity[], streaming: boolean): string {
  if (streaming) return activities.at(-1)!.message;
  if (activities.some(activity => activity.status === 'stopped')) return 'Activity stopped';
  return 'Activity complete';
}

function AgentActivity({ activities, streaming }: { activities: Activity[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!streaming) setExpanded(false); }, [streaming]);
  if (activities.length === 0) return null;
  return <section className={`ai-chat__activity ${streaming ? 'ai-chat__activity--live' : ''}`} aria-label="Agent activity">
    <button type="button" className="ai-chat__activity-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="ai-chat__activity-main">{streaming ? <LoaderCircle size={15} className="ai-chat__activity-spin" aria-hidden="true"/> : <Circle size={11} fill="currentColor" aria-hidden="true"/>}<span className="ai-chat__activity-title" aria-live="polite">{activitySummary(activities, streaming)}</span></span>
      <span className="ai-chat__activity-count">{activities.length} {activities.length === 1 ? 'step' : 'steps'}</span><ChevronDown size={15} className="ai-chat__activity-chevron" aria-hidden="true"/>
    </button>
    {expanded && <ol>{activities.map(activity => <li key={activity.key} className={`ai-chat__activity-step ai-chat__activity-step--${activity.status}`}>
      <span className="ai-chat__activity-symbol"><ActivityIcon activity={activity}/></span>
      <span className="ai-chat__activity-text"><span>{activity.message}</span>{activity.name && <code>{activity.name}</code>}</span>
    </li>)}</ol>}
  </section>;
}

type ChatComposerProps = Pick<AIElementsChatProps, 'canvasId' | 'hasApiKey' | 'model'> & {
  input: string;
  status: ChatStatus;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  onStop: () => void;
  placeholder?: string;
};

function ChatComposer({ canvasId, hasApiKey, model, input, status, onInput, onSubmit, onStop, placeholder }: ChatComposerProps) {
  return <div className="ai-chat__composer">
    <PromptInput onSubmit={({ text }) => onSubmit(text)}>
      <PromptInputBody><PromptInputTextarea aria-label="Message Symbi" value={input} onChange={event => onInput(event.currentTarget.value)} placeholder={placeholder ?? (canvasId ? 'Ask Symbi about this canvas…' : 'Open a canvas to start chatting…')}/></PromptInputBody>
      <PromptInputFooter><span>{hasApiKey ? model : 'Set up chat in Settings'}</span><PromptInputSubmit status={status} onStop={onStop} disabled={!input.trim() && status === 'ready'}/></PromptInputFooter>
    </PromptInput>
  </div>;
}

function AssistantResponse({ turn, streaming }: { turn: DisplayTurn; streaming: boolean }) {
  if (turn.content) return <MessageResponse>{turn.content}</MessageResponse>;
  if (streaming && turn.activities.length === 0) return <div className="ai-chat__pending"><span className="ai-chat__dots" aria-hidden="true"><i/><i/><i/></span>Thinking…</div>;
  return null;
}

function VerificationBadge({ verification, onNavigate }: { verification?: Verification; onNavigate: (target: CanvasNavigationTarget) => void }) {
  if (!verification || verification.status === 'no_claims') return null;
  if (verification.status === 'checking') return <span className="ai-chat__verify ai-chat__verify--checking"><LoaderCircle size={12} className="ai-chat__activity-spin" aria-hidden="true"/>Checking sources</span>;
  if (verification.status === 'unavailable') return <span className="ai-chat__verify ai-chat__verify--warn" role="status"><AlertTriangle size={12} aria-hidden="true"/>Source check unavailable</span>;
  const supported = verification.status === 'supported';
  const icon = supported ? <ShieldCheck size={12} aria-hidden="true"/> : <AlertTriangle size={12} aria-hidden="true"/>;
  const checked = verification.checkedClaims ?? verification.claims?.length ?? 0;
  const total = verification.totalClaims ?? checked;
  const label = checked === 0 ? supported ? 'No checkable claims found' : 'Source check needs review' : supported
    ? `${checked} of ${total} checked claims match sources` : `${checked} of ${total} claims checked · review needed`;
  if (!verification.claims?.length) return <span className={`ai-chat__verify ai-chat__verify--${supported ? 'ok' : 'warn'}`} role={supported ? undefined : 'note'}>{icon}{label}</span>;
  return <details className="ai-chat__verification">
    <summary className={`ai-chat__verify ai-chat__verify--${supported ? 'ok' : 'warn'}`}>{icon}{label}<ChevronDown size={12} aria-hidden="true"/></summary>
    <div className="ai-chat__verification-detail"><strong>Claim check</strong>
      <p>{total > checked ? `${total - checked} additional claims were not checked. ` : ''}Sources are limited to documents available to this canvas check.</p>
      <ul>{verification.claims.map((claim, index) => <li key={`${index}-${claim.text}`}>
      <span className={claim.supported ? 'is-supported' : 'is-unsupported'}>{claim.supported ? 'Supported' : 'Check source'}</span>
      <p>{claim.text}</p>
      {(claim.source?.evidence?.passage || claim.source?.excerpt) && <blockquote className="ai-chat__verification-excerpt">
        {claim.source?.evidence?.passageKind === 'exact' ? 'Exact source passage' : 'Approximate source context'}: {claim.source.evidence?.passage ?? claim.source.excerpt}
      </blockquote>}
      {claim.source?.evidence && <small>Checked {new Date(claim.source.evidence.checkedAt).toLocaleString()}
        {claim.source.evidence.revision ? ` · Revision ${claim.source.evidence.revision}` : claim.source.evidence.contentHash ? ` · Hash ${claim.source.evidence.contentHash}` : ''}</small>}
      {!claim.source?.evidence && claim.source?.contentHash && <small>Checked content hash {claim.source.contentHash.slice(0, 8)}</small>}
      {claim.source && <button type="button" onClick={() => onNavigate({ kind: 'document', canvasId: claim.source!.canvasId,
        blockId: claim.source!.blockId, title: claim.source!.title, excerpt: claim.source!.evidence?.passage ?? claim.source!.excerpt,
        contentHash: claim.source!.contentHash })}>Open {claim.source.title}</button>}
    </li>)}</ul>
    {verification.sources?.length ? <details><summary>Documents checked ({verification.sources.length})</summary><div className="ai-chat__verification-sources">{verification.sources.map(source =>
      <button type="button" key={`${source.canvasId}:${source.blockId}`} onClick={() => onNavigate({ kind: 'document', ...source })}>{source.title}</button>)}</div></details> : null}</div>
  </details>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { setCopied(false); }
  }
  return <button type="button" className="ai-chat__action" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy answer'} title="Copy answer">
    {copied ? <Check size={13} aria-hidden="true"/> : <Copy size={13} aria-hidden="true"/>}{copied ? 'Copied' : 'Copy'}
  </button>;
}

function TurnMessage({ turn, status, latestId, avatarState, question, undoingBlockId, onShowBlock, onNavigate, onOpenAnswerCanvas, onChooseSurface,
  onReturnNavigation, onUndoCreated, onUndoEdited, onSelectProposal, onApplyProposal, onUndoProposal }: { turn: DisplayTurn; status: ChatStatus; latestId?: number; avatarState: SymbiState; undoingBlockId: string | null;
  onShowBlock: (block: CanvasBlock, canvasId?: string) => void; onNavigate: (target: CanvasNavigationTarget) => void;
  onOpenAnswerCanvas: () => void; onChooseSurface: (prompt: string) => void;
  onReturnNavigation: () => void; onUndoCreated: (turnId: number, block: CanvasBlock) => void;
  onUndoEdited: (turnId: number, edit: CanvasEdit) => void;
  onSelectProposal: (turnId: number, changeId: string, selected: boolean) => void;
  onApplyProposal: (turnId: number) => void;
  onUndoProposal: (turnId: number) => void;
  question?: string }) {
  if (turn.role === 'user') return <Message from="user" className="ai-chat__user-turn"><MessageContent className="ai-chat__user-bubble">{turn.content}</MessageContent></Message>;
  const streaming = status !== 'ready' && turn.id === latestId;
  const answering = streaming && Boolean(turn.content) && turn.verification === undefined;
  return <Message from="assistant" className="ai-chat__assistant-turn">
    <SymbiAvatar size="small" state={turn.id === latestId ? avatarState : 'idle'} decorative/>
    <MessageContent className="ai-chat__assistant-content">
      <span className="ai-chat__sr-name">Symbi</span>
      {streaming && activityStatus(avatarState) && <span className="ai-chat__work-status" role="status"><span className="ai-chat__work-status-dot"/>{activityStatus(avatarState)}</span>}
      <AgentActivity activities={turn.activities} streaming={streaming}/>
      <div className={`ai-chat__answer${answering ? ' ai-chat__answer--streaming' : ''}`}>
        {turn.answerCanvas || turn.researchPatch ? <p>Research added to the canvas. Open it to explore the blocks, diagrams, links, and citations.</p>
          : <AssistantResponse turn={turn} streaming={streaming}/>}
      </div>
      {turn.presentationChoice && <div className="ai-chat__presentation-choices" aria-label="Choose how to continue">
        {turn.presentationChoice.options.map(option => <button key={option.label} type="button" disabled={status !== 'ready'}
          onClick={() => onChooseSurface(option.prompt)}><strong>{option.label}</strong><span>{option.detail}</span></button>)}
      </div>}
      {turn.navigation && <div className="ai-chat__navigation" role="status"><span>Opened {turn.navigation.title} on the canvas.</span>
        <button type="button" onClick={onReturnNavigation}>Go back</button></div>}
      {turn.proposal && <section className="ai-chat__proposal" aria-label="Review proposed document changes">
        <h3>{turn.proposalState === 'reverted' ? 'Changes reverted' : turn.proposalState === 'applied' ? 'Changes applied' : turn.proposalState === 'expired' ? 'Proposal expired' : turn.proposalState === 'failed' ? 'No changes saved' : 'Review proposed changes'}</h3>
        <p>{turn.proposal.changes.length} proposed change{turn.proposal.changes.length === 1 ? '' : 's'} on this canvas. Saved documents change only after Apply.</p>
        {turn.proposal.expiresAt && turn.proposalState === 'pending' && <p>Available until {new Date(turn.proposal.expiresAt).toLocaleString()}.</p>}
        {turn.proposal.changes.map(change => <div className="ai-chat__proposal-change" key={change.id}>
          <label><input type="checkbox" checked={(turn.selectedProposalIds ?? []).includes(change.id)} disabled={turn.proposalState !== 'pending' || change.canApply === false}
            onChange={event => onSelectProposal(turn.id, change.id, event.currentTarget.checked)}/>
            <span><strong>{change.type} · {change.title}</strong><small>{change.before ? 'Existing document' : 'New document'} · {change.blockId}</small></span></label>
          {change.canApply === false && <p>This change cannot be applied from Chat. Use the document controls to make it.</p>}
          <details><summary>Inspect full before and after</summary><div className="ai-chat__proposal-compare">
            <div><strong>Before</strong><pre>{change.before ? JSON.stringify({ title: change.before.title, kind: change.before.kind,
              x: change.before.x, y: change.before.y, links: change.before.links }, null, 2) + '\n\n' + change.before.content : '(new document)'}</pre></div>
            <div><strong>After</strong><pre>{change.after ? JSON.stringify({ title: change.after.title, kind: change.after.kind,
              x: change.after.x, y: change.after.y, links: change.after.links }, null, 2) + '\n\n' + change.after.content : '(removed document)'}</pre></div>
          </div></details>
        </div>)}
        {turn.proposalError && <p role="alert">{turn.proposalError}</p>}
        {turn.proposalState === 'pending' && <button type="button" className="primary-button" disabled={!(turn.selectedProposalIds?.length)} onClick={() => onApplyProposal(turn.id)}>Apply selected ({turn.selectedProposalIds?.length ?? 0})</button>}
        {turn.proposalState === 'applying' && <p role="status">Applying selected changes…</p>}
        {turn.proposalReceipt && <p role="status">{turn.proposalReceipt.applied.length} change{turn.proposalReceipt.applied.length === 1 ? '' : 's'} saved{turn.proposalReceipt.skipped.length ? `; ${turn.proposalReceipt.skipped.length} skipped` : ''}.
          {turn.proposalReceipt.skipped.map(item => <span key={item.id}> {item.id}: {item.reason}</span>)}</p>}
        {turn.proposalUndoReceipt && <p role="status">{turn.proposalUndoReceipt.reverted.length} change{turn.proposalUndoReceipt.reverted.length === 1 ? '' : 's'} reverted{turn.proposalUndoReceipt.skipped?.length ? `; ${turn.proposalUndoReceipt.skipped.length} still applied` : ''}.
          {turn.proposalUndoReceipt.skipped?.map(item => <span key={item.id}> {item.id}: {item.reason}</span>)}</p>}
        {turn.proposalState === 'applied' && <button type="button" className="secondary-button" onClick={() => onUndoProposal(turn.id)}>{turn.proposalUndoReceipt?.status === 'partial' ? 'Retry Undo for remaining changes' : 'Undo applied changes'}</button>}
        {turn.proposalState === 'expired' && <p>Ask Chat to prepare a fresh proposal, then review the current documents before applying.</p>}
        {turn.proposalState === 'reverted' && <p role="status">The applied changes were reverted. Review the current documents before proposing another change.</p>}
      </section>}
      {turn.createdBlocks?.map(block => <div className="ai-chat__created-row" key={block.id}>
        <button className="ai-chat__created" type="button" onClick={() => onShowBlock(block, turn.createdCanvasId)}>Show {block.title} on canvas</button>
        {turn.createdCanvasId && <button type="button" disabled={undoingBlockId === block.id}
          onClick={() => onUndoCreated(turn.id, block)}>{undoingBlockId === block.id ? 'Undoing…' : 'Undo creation'}</button>}
      </div>)}
      {turn.editedBlocks?.map(edit => <div className="ai-chat__created-row" key={edit.after.id}>
        <details className="ai-chat__edit-preview"><summary>Review changes to {edit.after.title}</summary>
          <p>Changed: {editPreview(edit).fields}</p>
          {edit.before.content !== edit.after.content && <div className="ai-chat__edit-compare">
            <div><strong>Before</strong><pre>{editPreview(edit).before}</pre></div>
            <div><strong>After</strong><pre>{editPreview(edit).after}</pre></div>
          </div>}
          <button type="button" onClick={() => onShowBlock(edit.after, turn.createdCanvasId)}>Open updated document</button>
        </details>
        {turn.createdCanvasId && <button type="button" disabled={undoingBlockId === edit.after.id}
          onClick={() => onUndoEdited(turn.id, edit)}>{undoingBlockId === edit.after.id ? 'Undoing…' : 'Undo edit'}</button>}
      </div>)}
      {turn.undoMessage && <p className="ai-chat__undo-message" role="status">{turn.undoMessage}</p>}
      {turn.undoError && <p className="ai-chat__undo-error" role="alert">{turn.undoError}</p>}
      {(turn.answerCanvas || turn.researchPatch) && <button className="ai-chat__source-button" type="button" onClick={onOpenAnswerCanvas}>
        Open research canvas · {turn.researchPatch?.blocks.length ?? 0} new block{turn.researchPatch?.blocks.length === 1 ? '' : 's'} ↗
      </button>}
      {status === 'ready' && question && !turn.presentationChoice && turn.content && <div className="ai-chat__surface-switch">
        {turn.answerCanvas || turn.researchPatch
          ? <button type="button" onClick={() => onChooseSurface(`Answer briefly in chat with no canvas for: ${question}`)}>Answer briefly in chat</button>
          : <button type="button" onClick={() => onChooseSurface(`Create a temporary research canvas for: ${question}`)}>Turn this into a map</button>}
      </div>}
      {turn.content && !answering && !turn.answerCanvas && !turn.researchPatch && <div className="ai-chat__actions"><CopyButton text={turn.content}/><VerificationBadge verification={turn.verification} onNavigate={onNavigate}/></div>}
    </MessageContent>
  </Message>;
}

export function AIElementsChat({ canvasId, canvas, viewContext, answerTurns, researchEdits, researchLayout, hasApiKey, jevAvailable = false, model, promptRequest, focusRequest,
  investigationOpenRequest, onActiveInvestigationChange, onMergeDraft, onOpenSettings,
  onCanvasChanged, onShowBlock, onNavigate, onReturnNavigation, onUndoCreatedBlock, onUndoEditedBlock, onCanvasSources, onCanvasPatch, onCanvasAnswer, onCanvasTurnEnd, onRestoreResearch, onOpenAnswerCanvas, onAvatarStateChange, onHistoryChange }: AIElementsChatProps) {
  const [input, setInput] = useState(() => {
    try { return window.sessionStorage.getItem('symbiknow:chat-draft') ?? ''; }
    catch { return ''; }
  });
  const [turns, setTurns] = useState<DisplayTurn[]>(restoredTurns);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [error, setError] = useState('');
  const [justFinished, setJustFinished] = useState(false);
  const [scope, setScope] = useState<ChatScope>('view');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [undoingBlockId, setUndoingBlockId] = useState<string | null>(null);
  const [connection, setConnection] = useState<'online' | 'checking' | 'restored'>('online');
  const [previousConversation, setPreviousConversation] = useState<DisplayTurn[] | null>(null);
  const [previousResearch, setPreviousResearch] = useState<InvestigationResearchSnapshot | undefined>();
  const [savedSourceOpened, setSavedSourceOpened] = useState(false);
  const turnsRef = useRef<DisplayTurn[]>(turns);
  const activeRef = useRef<AbortController | null>(null);
  const nextId = useRef(Math.max(0, ...turns.map(turn => turn.id)));
  const nextActivityId = useRef(0);
  const lastPromptSequence = useRef<number | null>(null);
  const pendingPrompts = useRef<Array<{ text: string; sequence: number; mergeDraft?: MergeDraftRequest }>>([]);
  const settingsRequested = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCanvasTurn = answerTurns.at(-1);
  const lastAnswerCanvas: AnswerCanvasResult | null = latestCanvasTurn?.sources.length ? {
    canvasId, query: latestCanvasTurn.query, selection: latestCanvasTurn.selection ?? 'local', sources: latestCanvasTurn.sources,
  } : null;
  const scopes = chatScopeOptions(canvas, viewContext, answerTurns);
  const activeScope = scopes.find(option => option.id === scope) ?? scopes[0];
  const suggestions = chatSuggestions(canvas, activeScope.context, lastAnswerCanvas);
  const latestTurn = turns.at(-1);
  const avatarState: SymbiState = error ? 'error'
    : status === 'ready' ? justFinished ? 'done' : 'idle'
    : latestTurn?.verification?.status === 'checking' ? 'jev-verifying'
    : activeToolState(latestTurn) ?? (status === 'submitted' && jevAvailable ? 'jev-routing'
      : latestTurn?.content ? 'speaking' : 'thinking');

  useEffect(() => { onAvatarStateChange?.(avatarState); }, [avatarState, onAvatarStateChange]);
  useEffect(() => { onHistoryChange?.(turns.length > 0); }, [turns.length, onHistoryChange]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(chatHistoryKey, JSON.stringify(turns.slice(-60))); }
      catch { /* The current conversation remains available in memory if browser storage is full. */ }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [turns]);
  useEffect(() => {
    const flush = () => {
      try { window.localStorage.setItem(chatHistoryKey, JSON.stringify(turnsRef.current.slice(-60))); }
      catch { /* Keep the active conversation in memory if browser storage is full. */ }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => {
    let active = true;
    for (const turn of turnsRef.current.filter(item => item.proposal && item.proposalState !== 'reverted' && item.proposalState !== 'expired')) {
      void api<ChatProposal | ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(turn.proposal!.id)}`).then(result => {
        if (!active) return;
        commit(turnsRef.current.map(item => item.id !== turn.id ? item : result.status === 'pending'
          ? { ...item, proposal: result, proposalState: 'pending' }
          : { ...item, proposalReceipt: result, proposalState: result.applied.length ? 'applied' : 'failed' }));
      }).catch(failure => {
        if (!active) return;
        commit(turnsRef.current.map(item => item.id === turn.id ? { ...item, proposalState: 'expired', proposalError: errorText(failure) } : item));
      });
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    setScope('view');
    document.querySelector<HTMLTextAreaElement>('.chat-panel textarea[aria-label="Message Symbi"]')?.focus();
  }, [focusRequest]);

  useEffect(() => () => { activeRef.current?.abort(); if (finishTimer.current) clearTimeout(finishTimer.current); }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem('symbiknow:chat-draft', input); }
    catch { /* Chat still works when session storage is unavailable. */ }
  }, [input]);

  useEffect(() => {
    if (!error.includes('server is unavailable')) { setConnection('online'); return; }
    setConnection('checking');
    let active = true;
    let checking = false;
    const probe = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/workspaces', { cache: 'no-store' });
        if (active && response.ok) { setConnection('restored'); window.clearInterval(timer); }
      } catch { /* The visible error remains until the connection returns. */ }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => { if (active) void probe(); }, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [error]);

  function commit(next: DisplayTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function openInvestigation(record: InvestigationRecord) {
    if (turnsRef.current.some(turn => turn.content.trim()) || answerTurns.length) {
      setPreviousConversation(turnsRef.current);
      if (researchEdits && researchLayout) setPreviousResearch({ turns: answerTurns, edits: researchEdits, layout: researchLayout });
    }
    const next = record.messages.map(message => ({ ...message, id: ++nextId.current, activities: [] as Activity[] }));
    commit(next);
    onActiveInvestigationChange?.({ id: record.id, canvasId: record.canvasId ?? canvasId });
    onRestoreResearch?.(record.researchSnapshot);
    setError('');
    setStatus('ready');
  }

  function openInvestigationSource(source: InvestigationSourceRef) {
    setSavedSourceOpened(true);
    onNavigate({ kind: 'document', canvasId: source.canvasId, blockId: source.blockId,
      title: canvas?.blocks.find(block => block.id === source.blockId)?.title ?? source.blockId,
      excerpt: source.excerpt, contentHash: source.contentHash });
  }

  async function openInvestigationProposal(reference: InvestigationProposalRef, record: InvestigationRecord) {
    if (reference.kind !== 'chat') throw new Error('This proposal is available in Jev Workspace runs.');
    const result = await api<ChatProposal | ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(reference.id)}`);
    const proposal: ChatProposal = result.status === 'pending' ? result : {
      id: result.id, canvasId: record.canvasId ?? canvasId, status: 'pending', changes: (result.documents ?? []).map(document => ({
        id: document.id, blockId: document.id, title: document.after?.title ?? document.before?.title ?? document.id,
        type: document.before ? document.after ? 'edit' as const : 'delete' as const : 'create' as const,
        before: document.before, after: document.after, expectedContentHash: null, canApply: false,
      })),
    };
    const next: DisplayTurn = { id: ++nextId.current, role: 'assistant', content: result.status === 'pending'
      ? 'Recovered the saved proposal for review.' : 'Recovered the saved proposal receipt and its document changes.', activities: [],
      proposal, selectedProposalIds: result.status === 'pending' ? result.changes.filter(change => change.canApply !== false).map(change => change.id) : [],
      proposalState: result.status === 'pending' ? 'pending' : result.applied.length ? 'applied' : 'failed',
      ...(result.status !== 'pending' ? { proposalReceipt: result } : {}),
    };
    commit([...turnsRef.current, next]);
  }

  function appendAssistant(base: DisplayTurn[], mergeDraft?: MergeDraftRequest): DisplayTurn[] {
    const next = [...base, { id: ++nextId.current, role: 'assistant' as const, content: '', activities: [], mergeDraft }];
    commit(next);
    return next;
  }

  async function runConversation(current: DisplayTurn[], beforeBlocks: CanvasBlock[], requestCanvasId: string,
    requestView: ChatViewContext, mergeDraft?: MergeDraftRequest) {
    const assistantId = current.at(-1)!.id;
    const controller = new AbortController();
    activeRef.current = controller;
    setError('');
    setJustFinished(false);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    setStatus('submitted');
    try {
      await streamCanvasChat({
        canvasId: requestCanvasId,
        viewContext: requestView,
        messages: current.filter(turn => turn.id !== assistantId && turn.content.trim()).map(({ role, content }) => ({ role, content })),
        previewMerge: Boolean(mergeDraft),
        intentToken: mergeDraft?.intentToken,
        signal: controller.signal,
        onChunk: chunk => {
          const next = updatedAssistant(turnsRef.current, assistantId, chunk);
          commit(next);
          onCanvasAnswer(assistantId, next.find(turn => turn.id === assistantId)?.content ?? '');
          setStatus('streaming');
        },
        onStep: step => {
          const next = updatedActivity(turnsRef.current, assistantId, step, ++nextActivityId.current);
          if (next !== turnsRef.current) commit(next);
          setStatus('streaming');
        },
        onReset: () => { commit(resetAssistant(turnsRef.current, assistantId, ++nextActivityId.current)); onCanvasAnswer(assistantId, ''); },
        onVerification: verification => commit(verifiedAssistant(turnsRef.current, assistantId, verification)),
        onAnswerCanvas: answer => {
          commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, answerCanvas: answer } : turn));
          onCanvasSources(assistantId, answer);
        },
        onNavigation: target => {
          commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, navigation: target } : turn));
          onNavigate(target);
        },
        onResearchPatch: patch => {
          commit(turnsRef.current.map(turn => turn.id === assistantId ? { ...turn, researchPatch: patch } : turn));
          onCanvasPatch(assistantId, patch);
        },
        onPresentationChoice: choice => commit(turnsRef.current.map(turn => turn.id === assistantId
          ? { ...turn, presentationChoice: choice } : turn)),
        onProposal: proposal => commit(turnsRef.current.map(turn => turn.id === assistantId
          ? { ...turn, proposal, selectedProposalIds: proposal.changes.filter(change => change.canApply !== false).map(change => change.id), proposalState: 'pending' } : turn)),
      });
      commit(discardIntentToken(settledAssistant(turnsRef.current, assistantId, 'complete'), assistantId));
      onCanvasTurnEnd(assistantId, 'complete');
      setJustFinished(true);
      finishTimer.current = setTimeout(() => { setJustFinished(false); finishTimer.current = null; }, 900);
      if (mergeDraft) {
        const answer = turnsRef.current.find(turn => turn.id === assistantId)?.content ?? '';
        const markdown = markdownDraft(answer);
        if (markdown !== undefined) onMergeDraft?.(markdown, mergeDraft);
      } else {
        const changes = await onCanvasChanged(requestCanvasId, beforeBlocks);
        if (changes.created.length || changes.updated.length) commit(turnsRef.current.map(turn => turn.id === assistantId
          ? { ...turn, createdBlocks: changes.created, editedBlocks: changes.updated, createdCanvasId: requestCanvasId } : turn));
      }
    } catch (failure) {
      commit(discardIntentToken(settledAssistant(turnsRef.current, assistantId, 'stopped'), assistantId));
      onCanvasTurnEnd(assistantId, 'stopped');
      if (!controller.signal.aborted) {
        const message = errorText(failure);
        setError(message);
        if (message.includes('server is unavailable')) setInput(value => value || current.filter(turn => turn.role === 'user').at(-1)?.content || '');
      }
    } finally {
      activeRef.current = null;
      setStatus('ready');
    }
  }

  function submit(text: string, mergeDraft?: MergeDraftRequest) {
    if (activeRef.current) return;
    if (!canvasId) { setError('Open a canvas before using the assistant.'); return; }
    if (!hasApiKey) { setError('Connect a chat model in Settings before using the assistant.'); onOpenSettings(); return; }
    const next = [...turnsRef.current, { id: ++nextId.current, role: 'user' as const, content: text, activities: [] }];
    setInput('');
    const conversation = appendAssistant(next, mergeDraft);
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, requestContextForScope(viewContext, activeScope), mergeDraft);
  }

  function retry() {
    const mergeDraft = turnsRef.current.at(-1)?.mergeDraft;
    const history = turnsRef.current.slice(0, -1);
    const conversation = appendAssistant(history, mergeDraft);
    setInput('');
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, requestContextForScope(viewContext, activeScope), mergeDraft);
  }

  async function undoCreated(turnId: number, block: CanvasBlock) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.createdCanvasId || undoingBlockId) return;
    setUndoingBlockId(block.id);
    try {
      await onUndoCreatedBlock(turn.createdCanvasId, block);
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        createdBlocks: item.createdBlocks?.filter(created => created.id !== block.id), undoMessage: `Undid creation of ${block.title}.`, undoError: '' } : item));
    } catch (failure) {
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, undoError: errorText(failure) } : item));
    } finally { setUndoingBlockId(null); }
  }

  async function undoEdited(turnId: number, edit: CanvasEdit) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.createdCanvasId || undoingBlockId) return;
    setUndoingBlockId(edit.after.id);
    try {
      await onUndoEditedBlock(turn.createdCanvasId, edit);
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        editedBlocks: item.editedBlocks?.filter(updated => updated.after.id !== edit.after.id),
        undoMessage: `Undid edit to ${edit.after.title}.`, undoError: '' } : item));
    } catch (failure) {
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, undoError: errorText(failure) } : item));
    } finally { setUndoingBlockId(null); }
  }

  function navigateToSource(turnId: number, target: CanvasNavigationTarget) {
    commit(turnsRef.current.map(turn => turn.id === turnId ? { ...turn, navigation: target } : turn));
    onNavigate(target);
  }

  function selectProposal(turnId: number, changeId: string, selected: boolean) {
    commit(turnsRef.current.map(turn => turn.id === turnId && turn.proposal?.changes.some(change => change.id === changeId && change.canApply !== false) ? { ...turn,
      selectedProposalIds: selected ? [...new Set([...(turn.selectedProposalIds ?? []), changeId])]
        : (turn.selectedProposalIds ?? []).filter(id => id !== changeId) } : turn));
  }

  async function applyProposal(turnId: number) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    const proposal = turn?.proposal;
    if (!proposal || turn.proposalState !== 'pending' || !turn.selectedProposalIds?.length) return;
    commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: 'applying', proposalError: '' } : item));
    try {
      const before = await api<CanvasDocument>(`/canvases/${encodeURIComponent(proposal.canvasId)}`);
      const receipt = await api<ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(proposal.id)}/apply`, {
        method: 'POST', body: JSON.stringify({ changeIds: turn.selectedProposalIds }),
      });
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: receipt.applied.length ? 'applied' : 'failed', proposalReceipt: receipt,
        proposalError: '' } : item));
      try { await onCanvasChanged(proposal.canvasId, before.blocks); }
      catch (failure) { commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        proposalError: `Changes saved, but the canvas could not refresh: ${errorText(failure)} Reopen the canvas to see them.` } : item)); }
    } catch (failure) {
      const message = errorText(failure);
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        proposalState: message.includes('no longer available') ? 'expired' : 'pending', proposalError: message } : item));
    }
  }

  async function undoProposal(turnId: number) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.proposal || turn.proposalState !== 'applied') return;
    commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: 'applying', proposalError: '' } : item));
    try {
      const before = await api<CanvasDocument>(`/canvases/${encodeURIComponent(turn.proposal.canvasId)}`);
      const receipt = await api<ChatProposalUndoReceipt>(`/chat/proposals/${encodeURIComponent(turn.proposal.id)}/undo`, { method: 'POST', body: JSON.stringify({}) });
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: receipt.status === 'reverted' ? 'reverted' : 'applied', proposalUndoReceipt: receipt } : item));
      try { await onCanvasChanged(turn.proposal.canvasId, before.blocks); }
      catch (failure) { commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        proposalError: `Undo saved, but the canvas could not refresh: ${errorText(failure)} Reopen the canvas to see it.` } : item)); }
    } catch (failure) {
      const message = errorText(failure);
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item,
        proposalState: message.includes('no longer available') ? 'expired' : 'applied', proposalError: message } : item));
    }
  }

  useEffect(() => {
    if (promptRequest && lastPromptSequence.current !== promptRequest.sequence) {
      pendingPrompts.current.push({ text: promptRequest.text, sequence: promptRequest.sequence, mergeDraft: promptRequest.mergeDraft });
      lastPromptSequence.current = promptRequest.sequence;
    }
    if (!pendingPrompts.current.length || !canvasId) return;
    if (!hasApiKey) {
      if (!settingsRequested.current) {
        settingsRequested.current = true;
        setError('Connect a chat model in Settings before using the assistant.');
        onOpenSettings();
      }
      return;
    }
    settingsRequested.current = false;
    if (activeRef.current) return;
    const next = pendingPrompts.current.shift()!;
    submit(next.text, next.mergeDraft);
  }, [promptRequest?.sequence, promptRequest?.text, canvasId, hasApiKey, status]);

  const latestId = turns.at(-1)?.id;
  const investigationSources = [...new Map(turns.flatMap(turn => [
    ...(turn.verification?.sources ?? []), ...(turn.answerCanvas?.sources ?? []),
  ]).concat(answerTurns.flatMap(turn => turn.sources)).filter(source => source.canvasId && source.blockId).map(source => [`${source.canvasId}:${source.blockId}`, {
    canvasId: source.canvasId, blockId: source.blockId,
    ...(source.contentHash && /^[a-f0-9]{16}$/.test(source.contentHash) ? { contentHash: source.contentHash } : {}),
    ...(source.excerpt ? { excerpt: source.excerpt.slice(0, 2_000) } : {}),
  }]))].map(([, source]) => source);
  const investigationProposals = turns.flatMap(turn => turn.proposal ? [{ kind: 'chat' as const, id: turn.proposal.id,
    status: turn.proposalState ?? 'pending' }] : []);

  function recheckInvestigation(record: InvestigationRecord, changedSources: Array<{ canvasId: string; blockId: string;
    oldHash?: string; currentHash?: string }>) {
    const previousAnswer = [...record.messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
    const sourceChanges = changedSources.map(source => `${source.canvasId}/${source.blockId}: saved hash ${source.oldHash ?? 'unknown'}, current hash ${source.currentHash ?? 'missing'}`);
    submit(`Recheck this saved investigation against the current documents. Compare the earlier answer with what the changed sources now support. Explain which claims remain supported, which changed, and what is still uncertain. Do not edit documents.\n\nEarlier answer:\n${previousAnswer.slice(0, 12_000)}\n\nChanged sources:\n${sourceChanges.join('\n')}`);
  }

  return <div className="ai-chat">
    {!hasApiKey && <div className="ai-chat__setup"><span>Connect a chat model in Settings to talk with this canvas.</span><button type="button" onClick={onOpenSettings}>Open Settings</button></div>}
    {canvas?.workspaceId && <SavedInvestigations workspaceId={canvas.workspaceId} canvasId={canvasId}
      messages={turns.filter(turn => turn.content.trim()).map(({ role, content }) => ({ role, content }))}
      sourceRefs={investigationSources} proposalRefs={investigationProposals}
      researchSnapshot={researchEdits && researchLayout ? { turns: answerTurns, edits: researchEdits, layout: researchLayout } : undefined}
      openRequest={investigationOpenRequest} onOpen={openInvestigation}
      onSaved={record => onActiveInvestigationChange?.({ id: record.id, canvasId: record.canvasId ?? canvasId })}
      onClearSelection={() => onActiveInvestigationChange?.(undefined)}
      onOpenSource={openInvestigationSource} onOpenProposal={openInvestigationProposal} onRecheck={recheckInvestigation}/>}
    {previousConversation && <div className="ai-chat__saved-return" role="status">Opened a saved investigation.
      <button type="button" onClick={() => { commit(previousConversation); onRestoreResearch?.(previousResearch); onActiveInvestigationChange?.(undefined); setPreviousConversation(null); setPreviousResearch(undefined); }}>Restore previous conversation and canvas</button>
      <button type="button" onClick={() => { setPreviousConversation(null); setPreviousResearch(undefined); }}>Dismiss</button></div>}
    {savedSourceOpened && <div className="ai-chat__saved-return" role="status">Opened a saved source.
      <button type="button" onClick={() => { onReturnNavigation(); setSavedSourceOpened(false); }}>Go back</button></div>}
    <Conversation className="ai-chat__conversation">
      <ConversationContent className="ai-chat__messages">
        {turns.length === 0 && <div className="ai-chat__welcome"><SymbiAvatar size="large" decorative/><h2>Hi, I’m Symbi.</h2><p>{canvasId ? 'Ask me to find sources, connect ideas, or build a map of what matters. I’ll show you where the answer came from.' : 'Open a canvas and ask me to find sources, connect ideas, or build a map of what matters.'}</p></div>}
        {turns.map((turn, index) => <TurnMessage key={turn.id} turn={turn} status={status} latestId={latestId} avatarState={avatarState}
          undoingBlockId={undoingBlockId} onReturnNavigation={onReturnNavigation} onUndoCreated={(id, block) => void undoCreated(id, block)}
          onUndoEdited={(id, edit) => void undoEdited(id, edit)}
          onSelectProposal={selectProposal} onApplyProposal={id => void applyProposal(id)} onUndoProposal={id => void undoProposal(id)}
          question={turn.role === 'assistant' ? turns.slice(0, index).reverse().find(item => item.role === 'user')?.content : undefined} onShowBlock={onShowBlock}
          onOpenAnswerCanvas={onOpenAnswerCanvas} onNavigate={target => navigateToSource(turn.id, target)} onChooseSurface={submit}/>)}
        {error && <div className="ai-chat__error" role="alert"><span>{error}</span>
          {connection !== 'online' && <small>{connection === 'restored' ? 'Connection restored. Your question is ready to retry.' : 'Checking the connection. Your question is still here.'}</small>}
          {hasApiKey && <button type="button" onClick={retry}>{connection === 'restored' ? 'Retry answer' : 'Retry'}</button>}</div>}
      </ConversationContent>
      <ConversationScrollButton className="ai-chat__scroll-latest" aria-label="Scroll to latest message"/>
    </Conversation>
    {turns.length === 0 ? <div className="ai-chat__starters" role="group" aria-label="Suggested questions">{suggestions.slice(0, 3).map(item => <button key={item.title} type="button" className="ai-chat__starter" onClick={() => submit(item.title)}><strong>{item.title}</strong><span>{item.detail}</span></button>)}</div>
      : status === 'ready' && <div className="ai-chat__followups" role="group" aria-label="Suggested follow-up questions">{suggestions.slice(0, 2).map(item => <button key={item.title} type="button" onClick={() => submit(item.title)}>{item.title}</button>)}</div>}
    <div className="ai-chat__context">
      <button type="button" aria-label="Choose assistant context" aria-expanded={scopeOpen} onClick={() => setScopeOpen(open => !open)}>
        <span>Using: <strong>{activeScope.detail}</strong></span><ChevronDown size={13} aria-hidden="true"/>
      </button>
      {scopeOpen && <div className="ai-chat__context-options" role="group" aria-label="Assistant context options">
        {scopes.map(option => <button key={option.id} type="button" aria-pressed={activeScope.id === option.id}
          onClick={() => { setScope(option.id); setScopeOpen(false); }}><strong>{option.label}</strong><span>{option.detail}</span></button>)}
      </div>}
    </div>
    <ChatComposer canvasId={canvasId} hasApiKey={hasApiKey} model={model} input={input} status={status} onInput={setInput} onSubmit={submit} onStop={() => activeRef.current?.abort()}
      placeholder={viewContext.editorDraft || viewContext.editingBlockId ? 'Ask Symbi to review or edit this document…' : undefined}/>
  </div>;
}
