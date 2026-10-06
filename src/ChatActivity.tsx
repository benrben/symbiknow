import { useEffect, useState } from 'react';
import { Check, ChevronDown, Circle, LoaderCircle, Square, Wrench } from 'lucide-react';
import type { Activity } from './chat-types';

function ActivityIcon({ activity }: { activity: Activity }) {
  if (activity.status === 'active') return <LoaderCircle size={14} className="ai-chat__activity-spin" aria-hidden="true" />;
  if (activity.status === 'stopped') return <Square size={12} aria-hidden="true" />;
  return activity.type === 'tool' ? <Wrench size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />;
}

function activitySummary(activities: Activity[], streaming: boolean): string {
  if (streaming) return activities.at(-1)!.message;
  if (activities.some(activity => activity.status === 'stopped')) return 'Activity stopped';
  return 'Activity complete';
}

export function AgentActivity({ activities, streaming }: { activities: Activity[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!streaming) setExpanded(false); }, [streaming]);
  if (activities.length === 0) return null;
  return <section className={`ai-chat__activity ${streaming ? 'ai-chat__activity--live' : ''}`} aria-label="Agent activity">
    <button type="button" className="ai-chat__activity-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="ai-chat__activity-main">{streaming ? <LoaderCircle size={15} className="ai-chat__activity-spin" aria-hidden="true" /> : <Circle size={11} fill="currentColor" aria-hidden="true" />}<span className="ai-chat__activity-title" aria-live="polite">{activitySummary(activities, streaming)}</span></span>
      <span className="ai-chat__activity-count">{activities.length} {activities.length === 1 ? 'step' : 'steps'}</span><ChevronDown size={15} className="ai-chat__activity-chevron" aria-hidden="true" />
    </button>
    {expanded && <ol>{activities.map(activity => <li key={activity.key} className={`ai-chat__activity-step ai-chat__activity-step--${activity.status}`}>
      <span className="ai-chat__activity-symbol"><ActivityIcon activity={activity} /></span>
      <span className="ai-chat__activity-text"><span>{activity.message}</span>{activity.name && <code>{activity.name}</code>}</span>
    </li>)}</ol>}
  </section>;
}

