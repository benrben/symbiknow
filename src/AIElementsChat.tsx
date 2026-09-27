import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Circle, Copy, LoaderCircle, ShieldCheck, Sparkles, Square, Wrench } from 'lucide-react';
import { Conversation, ConversationContent, ConversationScrollButton } from './components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from './components/ai-elements/prompt-input';
import { streamCanvasChat, type AgentStep, type ChatTurn, type Verification } from './chatStream';
import type { AnswerCanvasResult, AnswerCanvasTurn, CanvasNavigationTarget, ChatViewContext, ResearchCanvasPatch, ResearchSurfaceChoice } from '../shared/answer-canvas';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { chatSuggestions } from './chat-suggestions';
import { chatScopeOptions, type ChatScope } from './chat-context';
import type { CanvasChanges, CanvasEdit } from './canvas-changes';
import './ai-chat.css';

type AIElementsChatProps = {
  canvasId: string;
  canvas: CanvasDocument | null;
  viewContext: ChatViewContext;
  answerTurns: AnswerCanvasTurn[];
  hasApiKey: boolean;
  model: string;
  promptRequest?: { text: string; sequence: number; mergeDraft?: MergeDraftRequest };
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
  onOpenAnswerCanvas: () => void;
};

export type MergeDraftRequest = { keepBlockId: string; mergeBlockIds: string[]; intentToken?: string };

type Activity = { key: number; type: 'thinking' | 'tool'; id?: string; name?: string; message: string; status: 'active' | 'complete' | 'stopped' };
type DisplayTurn = ChatTurn & { id: number; activities: Activity[]; verification?: Verification; createdBlocks?: CanvasBlock[]; editedBlocks?: CanvasEdit[];
  createdCanvasId?: string; undoMessage?: string; undoError?: string;
  mergeDraft?: MergeDraftRequest; answerCanvas?: AnswerCanvasResult; researchPatch?: ResearchCanvasPatch;
  presentationChoice?: ResearchSurfaceChoice; navigation?: CanvasNavigationTarget };
type ChatStatus = 'ready' | 'submitted' | 'streaming';

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
};

function ChatComposer({ canvasId, hasApiKey, model, input, status, onInput, onSubmit, onStop }: ChatComposerProps) {
  return <div className="ai-chat__composer">
    <PromptInput onSubmit={({ text }) => onSubmit(text)}>
      <PromptInputBody><PromptInputTextarea aria-label="Message the SymbiKnow assistant" value={input} onChange={event => onInput(event.currentTarget.value)} placeholder={canvasId ? 'Ask anything about this canvas…' : 'Open a canvas to start chatting…'}/></PromptInputBody>
      <PromptInputFooter><span>{hasApiKey ? model : 'Set up chat in Settings'}</span><PromptInputSubmit status={status} onStop={onStop} disabled={!input.trim() && status === 'ready'}/></PromptInputFooter>
    </PromptInput>
  </div>;
}

function AssistantResponse({ turn, streaming }: { turn: DisplayTurn; streaming: boolean }) {
  if (turn.content) return <MessageResponse>{turn.content}</MessageResponse>;
  if (streaming && turn.activities.length === 0) return <div className="ai-chat__pending"><span className="ai-chat__dots" aria-hidden="true"><i/><i/><i/></span>Thinking…</div>;
  return null;
}

function VerificationBadge({ verification }: { verification?: Verification }) {
  if (!verification || verification.status === 'unavailable' || verification.status === 'no_claims') return null;
  if (verification.status === 'checking') return <span className="ai-chat__verify ai-chat__verify--checking"><LoaderCircle size={12} className="ai-chat__activity-spin" aria-hidden="true"/>Checking sources</span>;
  if (verification.status === 'supported') return <span className="ai-chat__verify ai-chat__verify--ok" title="TypeSafe Jev found the answer's claims in the canvas documents"><ShieldCheck size={12} aria-hidden="true"/>Matches canvas docs</span>;
  return <span className="ai-chat__verify ai-chat__verify--warn" role="note"><AlertTriangle size={12} aria-hidden="true"/>Some claims may not be in the canvas docs — check the sources</span>;
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

function TurnMessage({ turn, status, latestId, question, undoingBlockId, onShowBlock, onOpenAnswerCanvas, onChooseSurface,
  onReturnNavigation, onUndoCreated, onUndoEdited }: { turn: DisplayTurn; status: ChatStatus; latestId?: number; undoingBlockId: string | null;
  onShowBlock: (block: CanvasBlock, canvasId?: string) => void; onOpenAnswerCanvas: () => void; onChooseSurface: (prompt: string) => void;
  onReturnNavigation: () => void; onUndoCreated: (turnId: number, block: CanvasBlock) => void;
  onUndoEdited: (turnId: number, edit: CanvasEdit) => void;
  question?: string }) {
  if (turn.role === 'user') return <Message from="user" className="ai-chat__user-turn"><MessageContent className="ai-chat__user-bubble">{turn.content}</MessageContent></Message>;
  const streaming = status !== 'ready' && turn.id === latestId;
  const answering = streaming && Boolean(turn.content) && turn.verification === undefined;
  return <Message from="assistant" className="ai-chat__assistant-turn">
    <div className="ai-chat__avatar" aria-hidden="true"><Sparkles size={14}/></div>
    <MessageContent className="ai-chat__assistant-content">
      <span className="ai-chat__sr-name">SymbiKnow assistant</span>
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
      {turn.content && !answering && !turn.answerCanvas && !turn.researchPatch && <div className="ai-chat__actions"><CopyButton text={turn.content}/><VerificationBadge verification={turn.verification}/></div>}
    </MessageContent>
  </Message>;
}

export function AIElementsChat({ canvasId, canvas, viewContext, answerTurns, hasApiKey, model, promptRequest, onMergeDraft, onOpenSettings,
  onCanvasChanged, onShowBlock, onNavigate, onReturnNavigation, onUndoCreatedBlock, onUndoEditedBlock, onCanvasSources, onCanvasPatch, onCanvasAnswer, onCanvasTurnEnd, onOpenAnswerCanvas }: AIElementsChatProps) {
  const [input, setInput] = useState(() => {
    try { return window.sessionStorage.getItem('symbiknow:chat-draft') ?? ''; }
    catch { return ''; }
  });
  const [turns, setTurns] = useState<DisplayTurn[]>([]);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [error, setError] = useState('');
  const [scope, setScope] = useState<ChatScope>('view');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [undoingBlockId, setUndoingBlockId] = useState<string | null>(null);
  const [connection, setConnection] = useState<'online' | 'checking' | 'restored'>('online');
  const turnsRef = useRef<DisplayTurn[]>([]);
  const activeRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const nextActivityId = useRef(0);
  const lastPromptSequence = useRef<number | null>(null);
  const pendingPrompts = useRef<Array<{ text: string; sequence: number; mergeDraft?: MergeDraftRequest }>>([]);
  const settingsRequested = useRef(false);
  const latestCanvasTurn = answerTurns.at(-1);
  const lastAnswerCanvas: AnswerCanvasResult | null = latestCanvasTurn?.sources.length ? {
    canvasId, query: latestCanvasTurn.query, selection: latestCanvasTurn.selection ?? 'local', sources: latestCanvasTurn.sources,
  } : null;
  const scopes = chatScopeOptions(canvas, viewContext, answerTurns);
  const activeScope = scopes.find(option => option.id === scope) ?? scopes[0];
  const suggestions = chatSuggestions(canvas, activeScope.context, lastAnswerCanvas);

  useEffect(() => () => { activeRef.current?.abort(); }, []);
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
      });
      commit(discardIntentToken(settledAssistant(turnsRef.current, assistantId, 'complete'), assistantId));
      onCanvasTurnEnd(assistantId, 'complete');
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
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, activeScope.context, mergeDraft);
  }

  function retry() {
    const mergeDraft = turnsRef.current.at(-1)?.mergeDraft;
    const history = turnsRef.current.slice(0, -1);
    const conversation = appendAssistant(history, mergeDraft);
    setInput('');
    void runConversation(conversation, canvas?.blocks ?? [], canvasId, activeScope.context, mergeDraft);
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

  return <div className="ai-chat">
    {!hasApiKey && <div className="ai-chat__setup"><span>Connect a chat model in Settings to talk with this canvas.</span><button type="button" onClick={onOpenSettings}>Open Settings</button></div>}
    <Conversation className="ai-chat__conversation">
      <ConversationContent className="ai-chat__messages">
        {turns.length === 0 && <div className="ai-chat__welcome"><div className="ai-chat__welcome-icon"><Sparkles size={22} aria-hidden="true"/></div><h2>Build knowledge together</h2><p>Ask your agent to connect ideas, organize sources, and move shared work forward. Every edit stays in the document’s history.</p></div>}
        {turns.map((turn, index) => <TurnMessage key={turn.id} turn={turn} status={status} latestId={latestId}
          undoingBlockId={undoingBlockId} onReturnNavigation={onReturnNavigation} onUndoCreated={(id, block) => void undoCreated(id, block)}
          onUndoEdited={(id, edit) => void undoEdited(id, edit)}
          question={turn.role === 'assistant' ? turns.slice(0, index).reverse().find(item => item.role === 'user')?.content : undefined} onShowBlock={onShowBlock}
          onOpenAnswerCanvas={onOpenAnswerCanvas} onChooseSurface={submit}/>)}
        {error && <div className="ai-chat__error" role="alert"><span>{error}</span>
          {connection !== 'online' && <small>{connection === 'restored' ? 'Connection restored. Your question is ready to retry.' : 'Checking the connection. Your question is still here.'}</small>}
          {hasApiKey && <button type="button" onClick={retry}>{connection === 'restored' ? 'Retry answer' : 'Retry'}</button>}</div>}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to latest message"/>
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
    <ChatComposer canvasId={canvasId} hasApiKey={hasApiKey} model={model} input={input} status={status} onInput={setInput} onSubmit={submit} onStop={() => activeRef.current?.abort()}/>
  </div>;
}
