import type { AgentStep } from './chatStream';
import { chatHistoryKey } from './chat-history';
import { isSavedTurn } from './chat-history-values';
import type { SymbiState } from './SymbiAvatar';
import type { CanvasEdit } from './canvas-changes';
import type { Activity, DisplayTurn } from './chat-types';

export function restoredTurns(): DisplayTurn[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(chatHistoryKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(isSavedTurn).slice(-60)
      .map(turn => ({ ...turn, activities: finishActivity(turn.activities, 'stopped') }));
  } catch { return []; }
}

const searchTools = new Set(['search_docs', 'ask_symbi', 'find_by', 'related']);
const readingTools = new Set(['read_doc', 'read_canvas', 'read_file', 'download_file', 'jev_profile', 'memory_map', 'jev_activity', 'brain_inbox']);
const navigationTools = new Set(['show_doc_on_canvas', 'show_group_on_canvas', 'move_block']);
const writingTools = new Set(['upload_file', 'edit_file', 'write_file', 'delete_doc', 'apply_file_proposal', 'undo_file_proposal', 'restore_revision']);
const connectingTools = new Set(['link_blocks', 'unlink_blocks']);
const organizingTools = new Set(['draw_research_canvas', 'jev_do', 'jev_resolve', 'jev_undo', 'jev_configure', 'symbi_reflex']);
const toolStates: Array<[ReadonlySet<string>, SymbiState]> = [
  [searchTools, 'searching'],
  [readingTools, 'reading'], [navigationTools, 'moving'], [writingTools, 'writing'],
  [connectingTools, 'connecting'], [organizingTools, 'organizing'],
];

export function activeToolState(turn?: DisplayTurn): SymbiState | null {
  const tool = [...(turn?.activities ?? [])].reverse().find(activity => activity.type === 'tool' && activity.status === 'active');
  if (!tool) return null;
  return toolStateForName(tool.name ?? '');
}

function toolStateForName(name: string): SymbiState {
  return toolStates.find(([tools]) => tools.has(name))?.[1] ?? 'tooling';
}

const statusMessages = new Map<SymbiState, string>([
  ['searching', 'Searching documents…'], ['reading', 'Reading the source…'], ['working', 'Updating the canvas…'],
  ['navigating', 'Opening the right place…'], ['tooling', 'Working with a tool…'],
  ['moving', 'Opening the right place…'], ['writing', 'Preparing changes…'],
  ['connecting', 'Connecting documents…'], ['organizing', 'Organizing the research canvas…'],
  ['listening', 'Receiving your request…'], ['asking', 'Waiting for your decision…'],
  ['checking', 'Checking the connection…'],
]);

export function activityStatus(state: SymbiState): string | null {
  return statusMessages.get(state) ?? null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function editPreview(edit: CanvasEdit): { fields: string; before: string; after: string } {
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

export function updatedAssistant(turns: DisplayTurn[], id: number, content: string): DisplayTurn[] {
  return turns.map(turn => turn.id === id ? { ...turn, content: turn.content + content, activities: finishThinking(turn.activities) } : turn);
}

function finishThinking(activities: Activity[]): Activity[] {
  return activities.map(activity => activity.type === 'thinking' && activity.status === 'active' ? { ...activity, status: 'complete' } : activity);
}

export function finishActivity(activities: Activity[], outcome: 'complete' | 'stopped'): Activity[] {
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

export function updatedActivity(turns: DisplayTurn[], id: number, step: AgentStep, key: number): DisplayTurn[] {
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
export function resetAssistant(turns: DisplayTurn[], id: number, key: number): DisplayTurn[] {
  return turns.map(turn => {
    if (turn.id !== id || !turn.content.trim()) return turn.id === id ? { ...turn, content: '' } : turn;
    const note = turn.content.trim().replace(/\s+/g, ' ');
    return { ...turn, content: '', activities: [...finishThinking(turn.activities),
      { key, type: 'thinking' as const, message: note.length > 220 ? `${note.slice(0, 217)}…` : note, status: 'complete' as const }] };
  });
}

export function settledAssistant(turns: DisplayTurn[], id: number, outcome: 'complete' | 'stopped'): DisplayTurn[] {
  return turns.map(turn => turn.id === id ? { ...turn, activities: finishActivity(turn.activities, outcome) } : turn);
}
