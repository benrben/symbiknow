import { MessageResponse } from './components/ai-elements/message';
import { AgentActivity } from './ChatActivity';
import { ProposalReview } from './ChatProposalReview';
import { ChangedDocuments } from './ChatChangedDocuments';
import { ResearchSummary } from './ChatResearchSummary';
import { AnswerActions } from './ChatAnswerActions';
import { activityStatus } from './chat-turn-state';
import type { TurnMessageProps } from './chat-message-types';
import type { DisplayTurn } from './chat-types';

type AssistantProps = TurnMessageProps & { streaming: boolean };
export function AssistantContent(props: AssistantProps) {
  const { turn, streaming } = props;
  const answering = streaming && Boolean(turn.content);
  return <>
    <span className="ai-chat__sr-name">Symbi</span>
    <WorkStatus {...props} /><AgentActivity activities={turn.activities} streaming={streaming} />
    <div className={`ai-chat__answer${answering ? ' ai-chat__answer--streaming' : ''}`}><TurnAnswer turn={turn} streaming={streaming} /></div>
    <NavigationNotice {...props} />
    <ProposalReview {...props} /><ChangedDocuments {...props} /><ResearchSummary {...props} />
    <SurfaceSwitch {...props} /><AnswerActions {...props} answering={answering} />
  </>;
}
function WorkStatus({ streaming, avatarState }: Pick<AssistantProps, 'streaming' | 'avatarState'>) {
  const label = activityStatus(avatarState);
  return streaming && label && <span className="ai-chat__work-status" role="status"><span className="ai-chat__work-status-dot" />{label}</span>;
}
function TurnAnswer({ turn, streaming }: { turn: DisplayTurn; streaming: boolean }) {
  return turn.answerCanvas || turn.researchPatch ? <p>Research added to the canvas. Open it to explore the blocks, diagrams, links, and citations.</p>
    : <AssistantResponse turn={turn} streaming={streaming} />;
}
function AssistantResponse({ turn, streaming }: { turn: DisplayTurn; streaming: boolean }) {
  if (turn.content) return <MessageResponse>{turn.content}</MessageResponse>;
  if (streaming && turn.activities.length === 0) return <div className="ai-chat__pending"><span className="ai-chat__dots" aria-hidden="true"><i /><i /><i /></span>Thinking…</div>;
  return null;
}
function NavigationNotice({ turn, onReturnNavigation }: Pick<TurnMessageProps, 'turn' | 'onReturnNavigation'>) {
  return turn.navigation && <div className="ai-chat__navigation" role="status"><span>Opened {turn.navigation.title} on the canvas.</span>
    <button type="button" onClick={onReturnNavigation}>Go back</button></div>;
}
function SurfaceSwitch(props: TurnMessageProps) {
  const { turn, status, question } = props;
  if (status !== 'ready' || !question || !turn.content) return null;
  return <div className="ai-chat__surface-switch"><SurfaceButton turn={turn} question={question} onChooseSurface={props.onChooseSurface} /></div>;
}
function SurfaceButton({ turn, question, onChooseSurface }: Pick<TurnMessageProps, 'turn' | 'onChooseSurface'> & { question: string }) {
  return turn.answerCanvas || turn.researchPatch
    ? <button type="button" onClick={() => onChooseSurface(`Answer briefly in chat with no canvas for: ${question}`)}>Answer briefly in chat</button>
    : <button type="button" onClick={() => onChooseSurface(`Create a temporary research canvas for: ${question}`)}>Turn this into a map</button>;
}
